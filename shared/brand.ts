/**
 * The platform's brand in text: the words that name the product, its site
 * and its support address, per edition (shared/edition.ts).
 *
 *   - `iran` (and an unknown edition): WebYar's own strings, EXACTLY as the
 *     code always spelled them — "Webyar" / "وب‌یار" in prose, "Web Yar" for
 *     the commerce plugins, info@webyar.ai, https://webyar.ai. They are fixed,
 *     not read from the database, so the Iranian edition's text stays
 *     byte-identical whatever platform_branding holds.
 *   - `international`: the platform's own identity — its name per language
 *     from platform_branding_localized.platform_name (the source the panel
 *     title, e-mails and the widget credit already use), its site address and
 *     support e-mail from platform_domains (brandContactFromDomains). No
 *     WebYar word is ever a fallback there.
 *
 * Text carries the brand as tokens — `{{brand}}`, `{{brandLatin}}`,
 * `{{brandPlugin}}`, `{{supportEmail}}`, `{{siteUrl}}` — filled by
 * fillBrandTokens (the client's t() does it for every translation).
 *
 * Shared by the client (src/lib/brand.ts, src/i18n) and the server (push
 * notifications). Pure: no I/O.
 */
import type { Edition } from './edition.js';

export const BRAND_TOKENS = ['brand', 'brandLatin', 'brandPlugin', 'supportEmail', 'siteUrl'] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];
export type BrandTokens = Record<BrandToken, string>;

/**
 * The Iranian edition's brand strings — today's literals, per token:
 *   - `brand`: the product's name in prose ("Webyar"; "وب‌یار" in Persian).
 *   - `brandLatin`: the name where it is always Latin ("Webyar"), e.g. an
 *     app label or a demo workspace name inside Persian text.
 *   - `brandPlugin`: the commerce plugins' own name in WordPress, OpenCart
 *     and WHMCS ("Web Yar").
 */
export const IRAN_BRAND = {
  brand: { en: 'Webyar', fa: 'وب‌یار', tr: 'Webyar' } as Readonly<Record<string, string>>,
  brandLatin: 'Webyar',
  brandPlugin: 'Web Yar',
  supportEmail: 'info@webyar.ai',
  siteUrl: 'https://webyar.ai',
} as const;

/** The International edition's identity, as the platform's settings give it. */
export interface BrandIdentity {
  /** platform_branding_localized.platform_name per locale. */
  names: Readonly<Record<string, string>>;
  siteUrl: string | null;
  supportEmail: string | null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function baseLocale(locale: unknown): string {
  return clean(locale).toLowerCase().split('-')[0] || 'en';
}

/** The platform's name for a locale: that locale's, else English, else any; '' when none. */
export function brandNameFor(names: Readonly<Record<string, string>> | null | undefined, locale: unknown): string {
  if (!names) return '';
  const loc = baseLocale(locale);
  return clean(names[loc]) || clean(names.en) || Object.values(names).map(clean).find(Boolean) || '';
}

/** A host name for an https URL, without a leading `www.`; '' when it is not one. */
function siteHost(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./i, '') : '';
  } catch {
    return '';
  }
}

/**
 * The brand tokens for an edition and locale. `iran` and an unknown edition
 * (null) give today's WebYar strings; `international` gives the platform's
 * own identity — its name in every name token, its site and support e-mail —
 * and never a WebYar word (a missing name falls back to the site's host).
 */
export function brandTokensFor(
  edition: Edition | null | undefined,
  locale: unknown,
  identity?: BrandIdentity | null,
): BrandTokens {
  if (edition !== 'international') {
    const loc = baseLocale(locale);
    return {
      brand: IRAN_BRAND.brand[loc] ?? IRAN_BRAND.brand.en,
      brandLatin: IRAN_BRAND.brandLatin,
      brandPlugin: IRAN_BRAND.brandPlugin,
      supportEmail: IRAN_BRAND.supportEmail,
      siteUrl: IRAN_BRAND.siteUrl,
    };
  }
  const siteUrl = clean(identity?.siteUrl);
  const host = siteHost(siteUrl);
  const name = brandNameFor(identity?.names, locale) || host;
  const latin = brandNameFor(identity?.names, 'en') || name;
  return {
    brand: name,
    brandLatin: latin,
    brandPlugin: latin,
    supportEmail: clean(identity?.supportEmail) || (host ? `support@${host}` : ''),
    siteUrl,
  };
}

const TOKEN_RE = /\{\{(brand|brandLatin|brandPlugin|supportEmail|siteUrl)\}\}/g;

/** Replace every brand token in `text`; text without one is returned as is. */
export function fillBrandTokens(text: string, tokens: BrandTokens): string {
  if (!text || text.indexOf('{{') < 0) return text;
  return text.replace(TOKEN_RE, (_m, key: BrandToken) => tokens[key]);
}

/**
 * The public site address and support e-mail from a platform_domains row:
 * the canonical (else public) base URL, else https://<primary_domain>; the
 * support address is support@<that host> (without `www.`). Nulls when the
 * row names no address.
 */
export function brandContactFromDomains(row: Record<string, unknown> | null | undefined): {
  site_url: string | null;
  support_email: string | null;
} {
  const fromUrl = (value: unknown): string | null => {
    const raw = clean(value);
    if (!/^https?:\/\//i.test(raw)) return null;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  };
  const domain = clean(row?.primary_domain).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const siteUrl = fromUrl(row?.canonical_base_url) ?? fromUrl(row?.public_base_url)
    ?? (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain.toLowerCase()}` : null);
  const host = siteHost(siteUrl);
  return { site_url: siteUrl, support_email: host ? `support@${host}` : null };
}
