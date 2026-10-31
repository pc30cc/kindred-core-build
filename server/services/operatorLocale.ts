/**
 * The language a server-rendered text for an OPERATOR is written in: the
 * operator API bodies the native apps print, the transcript, digest and
 * offline-capture emails, push.
 *
 * The rule generalises the billing recipient's (billing/account/notify.ts,
 * billingRecipient) and migration 158 (profiles no longer default to 'en',
 * so the platform's default can apply):
 *
 *   profiles.preferred_locale (base tag, fa/en/tr), when the panel offers it
 *   → platform_settings.default_locale, when the panel offers it
 *   → the panel's first language
 *   → 'en'
 *
 * "Offers" means the dashboard's languages (shared/panelLanguages.ts,
 * Super Admin → Branding → Languages), not the visitors': a WebYar panel the
 * Super Admin opened to English writes an English operator's push in
 * English, while the widget stays Persian.
 *
 * A language the panel does not offer is never the operator's: the
 * dashboard switches it to the panel's default (src/hooks/
 * usePlatformRegion.ts usePanelLanguages), and every account from before
 * migration 158 still carries 'en', so on a Persian-only panel that operator
 * reads Persian.
 *
 * The dashboard decides its own UI language in the browser
 * (src/i18n/index.tsx); this is only for text the server writes.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { getPlatformPanelLanguages } from './platformRegion.js';

export type OperatorLocale = 'fa' | 'en' | 'tr';

const OPERATOR_LOCALES: readonly OperatorLocale[] = ['fa', 'en', 'tr'];

const CACHE_TTL_MS = 60_000;
/** A failed read is retried after this long (the fallback is used meanwhile). */
const FAILURE_TTL_MS = 5_000;

/** 'fa-IR' → 'fa'; null for anything that is not one of the three languages. */
function baseTag(value: unknown): OperatorLocale | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0] as OperatorLocale;
  return OPERATOR_LOCALES.includes(base) ? base : null;
}

/**
 * The panel's languages among fa/en/tr (getPlatformPanelLanguages, cached
 * there); [] when they cannot be read, and then any choice is kept.
 */
async function offeredLocales(config: ServerConfig): Promise<OperatorLocale[]> {
  try {
    return (await getPlatformPanelLanguages(config)).locales
      .map(baseTag)
      .filter((l): l is OperatorLocale => l !== null);
  } catch {
    return [];
  }
}

function offers(allowed: readonly OperatorLocale[], locale: OperatorLocale | null): locale is OperatorLocale {
  return locale !== null && (allowed.length === 0 || allowed.includes(locale));
}

let fallbackCache: { value: OperatorLocale; ts: number; ok: boolean } | null = null;
let fallbackInflight: Promise<OperatorLocale> | null = null;
const userCache = new Map<string, { value: OperatorLocale; ts: number }>();

/**
 * The platform's language for an operator who chose none:
 * `platform_settings.default_locale` when it is one the platform offers,
 * else the first allowed locale, else 'en'. Cached for 60 s; a failed read
 * falls back to the allowed locales and never throws.
 */
export async function operatorFallbackLocale(config: ServerConfig): Promise<OperatorLocale> {
  const now = Date.now();
  if (fallbackCache && now - fallbackCache.ts < (fallbackCache.ok ? CACHE_TTL_MS : FAILURE_TTL_MS)) {
    return fallbackCache.value;
  }
  if (fallbackInflight) return fallbackInflight;
  fallbackInflight = (async () => {
    const allowed = await offeredLocales(config);
    let preferred: OperatorLocale | null = null;
    let ok = true;
    try {
      const sb = getServiceClient(config);
      const { data, error } = await sb.from('platform_settings').select('default_locale').limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      preferred = baseTag((data as { default_locale?: unknown } | null)?.default_locale);
    } catch {
      ok = false;
    }
    const value: OperatorLocale = offers(allowed, preferred) ? preferred : (allowed[0] ?? 'en');
    fallbackCache = { value, ts: Date.now(), ok };
    return value;
  })().finally(() => {
    fallbackInflight = null;
  });
  return fallbackInflight;
}

/**
 * The operator's language from a preferred_locale the caller has already
 * read (push, the email dispatcher): kept when it is fa/en/tr and the
 * platform offers it, else operatorFallbackLocale.
 */
export async function operatorLocaleFrom(config: ServerConfig, preferred: unknown): Promise<OperatorLocale> {
  const chosen = baseTag(preferred);
  if (chosen && offers(await offeredLocales(config), chosen)) return chosen;
  return operatorFallbackLocale(config);
}

/**
 * Each operator's language, in one profiles read. Every id in `userIds`
 * gets a value: the profile's preferred_locale when it is fa/en/tr and the
 * platform offers it, else operatorFallbackLocale. A failed read gives
 * everyone the fallback.
 */
export async function operatorLocales(
  config: ServerConfig,
  userIds: readonly string[],
): Promise<Map<string, OperatorLocale>> {
  const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id))];
  const out = new Map<string, OperatorLocale>();
  if (!ids.length) return out;
  const chosen = new Map<string, OperatorLocale>();
  try {
    const sb = getServiceClient(config);
    const [{ data, error }, allowed] = await Promise.all([
      sb.from('profiles').select('id, preferred_locale').in('id', ids),
      offeredLocales(config),
    ]);
    if (!error) {
      for (const row of (data ?? []) as Array<{ id?: unknown; preferred_locale?: unknown }>) {
        const locale = baseTag(row.preferred_locale);
        if (offers(allowed, locale) && row.id != null) chosen.set(String(row.id), locale);
      }
    }
  } catch {
    // Everyone gets the platform's language below.
  }
  const fallback = ids.some((id) => !chosen.has(id)) ? await operatorFallbackLocale(config) : 'en';
  for (const id of ids) out.set(id, chosen.get(id) ?? fallback);
  return out;
}

/**
 * One operator's language for a request (the operator read APIs), cached
 * per user for 60 s. No user id gives the platform's language.
 */
export async function operatorLocale(
  config: ServerConfig,
  userId: string | null | undefined,
): Promise<OperatorLocale> {
  if (!userId) return operatorFallbackLocale(config);
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
  const value = (await operatorLocales(config, [userId])).get(userId) ?? (await operatorFallbackLocale(config));
  if (userCache.size > 5_000) userCache.clear();
  userCache.set(userId, { value, ts: Date.now() });
  return value;
}

/** Test-only — forget the cached platform and per-user languages. */
export function __resetOperatorLocaleCache(): void {
  fallbackCache = null;
  fallbackInflight = null;
  userCache.clear();
}
