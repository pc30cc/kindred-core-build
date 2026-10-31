/**
 * The dashboard's own languages: which ones the panel (app.*, its sign-in
 * pages and the Super Admin) may be shown in, which one it opens in, and
 * whether people see a language switcher. Set in Super Admin → Branding →
 * Platform settings (`platform_settings.active_locales`, `default_locale`,
 * `site_mode`).
 *
 * The language never changes the brand or the edition (shared/edition.ts):
 * a WebYar panel in English or Turkish is still WebYar, with Toman, the
 * Iranian gateways and +98 phones (owner, 2026-10-31). Only the Persian
 * Jalali calendar follows Persian text (src/lib/date.ts).
 *
 *   - `turkey` / `global` pin one language (tr / en), as they always did.
 *   - `iran` and `multi`: the active languages the Super Admin picked (none
 *     picked: `iran` Persian, `multi` all three), opening in the default
 *     language (when it is not among them, the first one).
 *   - `site_mode = 'single_language'` hides the switcher: everyone sees the
 *     default language only. Anything else (the column default is
 *     `multi_language`) shows it when there is more than one language.
 *
 * This is the PANEL only. What visitors and customers read (the chat and
 * call widgets, AI replies, Telegram, e-mail templates, knowledge base and
 * canned-response languages) keeps the region's rule
 * (server/services/platformRegion.ts getPlatformAllowedLocales,
 * src/lib/region.ts allowedLocalesFor): Persian only in `iran`.
 *
 * Shared by the client (src/hooks/usePlatformRegion.ts usePanelLanguages,
 * src/i18n) and the server (operator push and API texts,
 * server/services/operatorLocale.ts; the boot script's default language,
 * server/routes/platformPublic.ts). Pure: no I/O.
 */
import { parseRegionMode } from './edition.js';

export const PANEL_LOCALES = ['en', 'fa', 'tr'] as const;
export type PanelLocale = (typeof PANEL_LOCALES)[number];

export interface PanelLanguageSettings {
  region_mode?: unknown;
  active_locales?: unknown;
  default_locale?: unknown;
  site_mode?: unknown;
}

export interface PanelLanguages {
  /** The languages the panel may be shown in, in the order the Super Admin's list keeps them. */
  locales: PanelLocale[];
  /** The language the panel opens in until someone picks another. */
  defaultLocale: PanelLocale;
  /** A language switcher is shown (more than one language, and the Super Admin did not hide it). */
  switcher: boolean;
}

export function isPanelLocale(value: unknown): value is PanelLocale {
  return typeof value === 'string' && (PANEL_LOCALES as readonly string[]).includes(value);
}

/** 'fa-IR' → 'fa'; null for anything that is not one of the panel's languages. */
function baseLocale(value: unknown): PanelLocale | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isPanelLocale(base) ? base : null;
}

const PINNED: Partial<Record<string, PanelLocale>> = { turkey: 'tr', global: 'en' };

export function panelLanguagesFor(settings: PanelLanguageSettings | null | undefined): PanelLanguages {
  const mode = parseRegionMode(settings?.region_mode);
  const pinned = PINNED[mode];
  if (pinned) return { locales: [pinned], defaultLocale: pinned, switcher: false };

  const picked: PanelLocale[] = [];
  for (const value of Array.isArray(settings?.active_locales) ? settings.active_locales : []) {
    const locale = baseLocale(value);
    if (locale && !picked.includes(locale)) picked.push(locale);
  }
  const active: PanelLocale[] = picked.length ? picked : mode === 'iran' ? ['fa'] : [...PANEL_LOCALES];
  const wanted = baseLocale(settings?.default_locale);
  const defaultLocale = wanted && active.includes(wanted) ? wanted : active[0];

  if (settings?.site_mode === 'single_language') {
    return { locales: [defaultLocale], defaultLocale, switcher: false };
  }
  return { locales: active, defaultLocale, switcher: active.length > 1 };
}
