import { isolateBidi } from './bidi';
import { normalizeLocaleTag } from './geo/countryLocalization';
import { localizedIranProvince } from './geo/iranProvinceLocalization';
import { turkishAblativeForm } from './geo/turkishGrammar';

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
 * ── Iran uses province, not city ──────────────────────────────────────────
 * For a visitor whose canonical `country_code` is IR, the anonymous label
 * is built from `geo.region` (their province — "Visitor from {region} ·
 * {code}" / "بازدیدکننده از استان {region} · {code}"), never `geo.city` —
 * even when both are populated. This replaced an earlier, much heavier
 * city-level Persian localization system; province is a small, fixed,
 * 31-entry table (./geo/iranProvinceLocalization.ts) instead. Every other
 * country's anonymous label still uses `geo.city`, canonical/untranslated,
 * exactly as before — this is an Iran-specific identity rule, not a
 * general city→region swap.
 *
 * Email/phone are CONTACT METADATA, not a display-name fallback — a contact
 * known only by email still renders as "Visitor from {city} · {code}" here.
 * Callers show the email/phone separately (Contacts row/detail already do;
 * Inbox shows it in the contact header) — this function is only ever asked
 * "what is this contact called", not "what contact info do we have".
 *
 * The anonymous label is a PRESENTATION string only — never persist it into
 * `name`/`display_name`. The real identity stays `name: null` (or the
 * literal placeholder) + `visitor_code` + geo metadata; this function just
 * renders them together. `geo.city` itself is untouched canonical metadata
 * — still available for Visitor Intelligence/Map/analytics — it's simply no
 * longer part of the Iranian anonymous-identity string.
 */
export interface DisplayableContact {
  name?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
  visitor_code?: string | null;
}

export type ContactDisplayT = (key: string, vars?: Record<string, string>) => string;

/**
 * Canonical geo shape (matches `VisitorNetworkGeo` from
 * server/services/visitors/networkProfile.ts) so city localization can key
 * off `country_code` and never collide two same-named cities in different
 * countries. Passing a bare string is still supported for callers that only
 * have a city string handy — it just skips curated localization (no code to
 * key against) and falls straight to the canonical name.
 */
export interface DisplayGeoInfo {
  city?: string | null;
  country_code?: string | null;
  region?: string | null;
}

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
 * @param geo optional current city (or full `{city, country_code, region}`)
 *   for this visitor — pass whatever the caller already has (Inbox:
 *   `conversation.visitor_network.geo`; Contacts: `networkProfile.geo` or
 *   `metadata`); never fetched by this function. A bare string is still
 *   accepted for callers that only have a city name, at the cost of skipping
 *   curated localization (no country_code to key against). For a visitor
 *   whose `country_code` is IR, `geo.region` (province) is used instead of
 *   `geo.city` — see the module doc comment.
 * @param locale active UI locale ('en' | 'fa' | 'tr' or a variant like
 *   'fa-IR') — drives Iran province localization and, for Turkish, the
 *   ablative suffix ("İzmir'den ziyaretçi"). Omit to keep the canonical
 *   (English) name, e.g. for non-UI contexts.
 */
export function contactDisplayName(
  contact: DisplayableContact | null | undefined,
  fallbackId: string | null | undefined,
  t: ContactDisplayT,
  geo?: string | null | DisplayGeoInfo,
  locale?: string,
): string {
  const name = (contact?.name ?? '').trim();
  if (name && name.toLowerCase() !== PLACEHOLDER) return name;
  const code = resolveVisitorCode(contact, fallbackId);
  const isolatedCode = isolateBidi(code);
  const geoInfo: DisplayGeoInfo = typeof geo === 'string' || geo == null
    ? { city: geo ?? null }
    : geo;
  const isIran = (geoInfo.country_code ?? '').trim().toUpperCase() === 'IR';
  const cleanPlace = sanitizeCity(isIran ? geoInfo.region : geoInfo.city);
  if (!cleanPlace) {
    return t('inbox.visitorAnonymous', { code: isolatedCode });
  }
  const loc = normalizeLocaleTag(locale);
  // Iran: province, localized to Persian only in the fa locale (never
  // guessed for other countries — no city/region translation exists for
  // anyone else). Everywhere else: the canonical city, untranslated.
  const localizedPlace = isIran
    ? (localizedIranProvince(cleanPlace, geoInfo.country_code, loc) ?? cleanPlace)
    : cleanPlace;
  // Turkish grammar needs the place pre-suffixed ("İzmir'den") before
  // interpolation — tr.ts's templates are `{{city}} ziyaretçi · {{code}}` /
  // `{{region}} ziyaretçi · {{code}}`, not `from {{...}}`, because the
  // ablative suffix depends on the actual word (vowel harmony), not
  // something a static template can express.
  const placeForTemplate = loc === 'tr' ? turkishAblativeForm(localizedPlace) : localizedPlace;
  const isolatedPlace = isolateBidi(placeForTemplate);
  return isIran
    ? t('inbox.visitorAnonymousFromRegion', { region: isolatedPlace, code: isolatedCode })
    : t('inbox.visitorAnonymousFromCity', { city: isolatedPlace, code: isolatedCode });
}
