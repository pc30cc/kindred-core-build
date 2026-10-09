/**
 * The platform's brand in text on the client (shared/brand.ts): what the
 * `{{brand}}`, `{{brandLatin}}`, `{{brandPlugin}}`, `{{supportEmail}}` and
 * `{{siteUrl}}` tokens in translations and other copy read.
 *
 *   - Iranian edition — and an edition not known yet: WebYar's own strings,
 *     exactly as before (fixed, never read from the database).
 *   - International edition: the platform's name per language
 *     (platform_branding_localized) and its site / support address
 *     (platform_domains), from the public config.
 *
 * The identity is cached in localStorage (`wy-brand`) so a reload — and
 * index.html's boot script, which reads the same key — already knows it.
 * React components re-render on a change through useBrandTokens() (the
 * i18n provider subscribes, so every t() is filled).
 */
import { useSyncExternalStore } from 'react';
import { brandTokensFor, fillBrandTokens, type BrandIdentity, type BrandTokens } from '../../shared/brand';
import { knownEdition } from '@/lib/edition';
import type { Edition } from '../../shared/edition';

export { fillBrandTokens, type BrandTokens };

/** Read by index.html's boot script too: keep the name and shape in step. */
export const BRAND_CACHE_KEY = 'wy-brand';

interface CachedBrand {
  names: Record<string, string>;
  siteUrl: string | null;
  supportEmail: string | null;
}

function readCache(): CachedBrand | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CachedBrand> | null;
    if (!v || typeof v !== 'object') return null;
    const names: Record<string, string> = {};
    if (v.names && typeof v.names === 'object') {
      for (const [k, n] of Object.entries(v.names)) if (typeof n === 'string' && n.trim()) names[k] = n.trim();
    }
    return {
      names,
      siteUrl: typeof v.siteUrl === 'string' ? v.siteUrl : null,
      supportEmail: typeof v.supportEmail === 'string' ? v.supportEmail : null,
    };
  } catch {
    return null;
  }
}

let identity: CachedBrand | null = null;
let identityRead = false;
let edition: Edition | null = null;
let version = 0;
const listeners = new Set<() => void>();

function currentIdentity(): CachedBrand | null {
  if (!identityRead) {
    identity = readCache();
    identityRead = true;
  }
  return identity;
}

/** This page's origin as a site address, without a leading `app.` label (a last resort). */
function originSite(): string | null {
  try {
    if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return null;
    return `${window.location.protocol}//${window.location.host.replace(/^app\./i, '')}`;
  } catch {
    return null;
  }
}

function brandIdentity(): BrandIdentity {
  const id = currentIdentity();
  return {
    names: id?.names ?? {},
    siteUrl: id?.siteUrl || originSite(),
    supportEmail: id?.supportEmail ?? null,
  };
}

/** The edition the brand follows: the one set with the identity, else what this page knows, else unknown (Iran). */
function brandEdition(): Edition | null {
  return edition ?? knownEdition();
}

/** The brand tokens for a locale, as this page knows the platform now. */
export function brandTokens(locale: string): BrandTokens {
  return brandTokensFor(brandEdition(), locale, brandIdentity());
}

/** The product's name for a locale (the `{{brand}}` token). */
export function brandName(locale: string): string {
  return brandTokens(locale).brand;
}

/**
 * Called when the public config has arrived: the edition and the platform's
 * identity. Remembered for the next first paint; subscribers re-render.
 */
export function setPlatformBrand(next: {
  edition: Edition;
  localized: ReadonlyArray<{ locale?: unknown; platform_name?: unknown } | null | undefined>;
  siteUrl?: string | null;
  supportEmail?: string | null;
}): void {
  const names: Record<string, string> = {};
  for (const row of next.localized) {
    const name = typeof row?.platform_name === 'string' ? row.platform_name.trim() : '';
    if (typeof row?.locale === 'string' && name) names[row.locale] = name;
  }
  const value: CachedBrand = { names, siteUrl: next.siteUrl ?? null, supportEmail: next.supportEmail ?? null };
  // Re-render only when a token would read differently: in the Iranian
  // edition they never do (its words are fixed), so nothing re-renders there.
  const before = tokenSignature();
  identity = value;
  edition = next.edition;
  identityRead = true;
  const same = tokenSignature() === before;
  try {
    window.localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: the next first paint just does not know it yet */
  }
  if (same) return;
  version += 1;
  listeners.forEach((l) => l());
}

function tokenSignature(): string {
  return JSON.stringify(['en', 'fa', 'tr'].map((l) => brandTokens(l)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that changes whenever the brand does (for memo/effect dependencies). */
export function useBrandVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Test-only: forget everything set or read. */
export function __resetBrandForTests(): void {
  identity = null;
  identityRead = false;
  edition = null;
  version += 1;
  listeners.forEach((l) => l());
}

/**
 * The brand for a fixed-language page (the English legal pages): its tokens
 * and a filler for its texts. Re-renders when the brand changes.
 */
export function useBrandTokens(locale: string): BrandTokens & { fill: (text: string) => string } {
  useBrandVersion();
  const tokens = brandTokens(locale);
  return { ...tokens, fill: (text: string) => fillBrandTokens(text, tokens) };
}
