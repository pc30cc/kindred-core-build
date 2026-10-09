/**
 * The platform's edition: one codebase runs two products.
 *
 *   - `iran`          — the local Iranian site (WebYar): Toman (stored as IRR),
 *                       Iranian gateways, Jalali calendar, +98 phones, the
 *                       Rial wallet and AI-credit top-ups. Exactly as before.
 *   - `international` — every other deployment (RESPOK): USD, international
 *                       gateways only, Gregorian calendar. No trace of Iran:
 *                       Persian there is only right-to-left Persian text.
 *
 * The edition is `iran` if and only if `platform_settings.region_mode` is
 * `'iran'`; `multi`, `global`, `turkey` (and a missing row, whose column
 * default is `multi`) are `international`.
 *
 * Shared by the server (server/services/platformRegion.ts → getPlatformEdition)
 * and the client (src/hooks/useEdition.ts). Pure: no I/O.
 */

export const EDITIONS = ['iran', 'international'] as const;
export type Edition = (typeof EDITIONS)[number];

/** `platform_settings.region_mode` → edition. Only the exact value `'iran'` is Iran. */
export function resolveEdition(regionMode: unknown): Edition {
  return regionMode === 'iran' ? 'iran' : 'international';
}

/** A stored edition value (a cache, a hint) → the edition, or null when it is not one. */
export function parseEdition(value: unknown): Edition | null {
  return value === 'iran' || value === 'international' ? value : null;
}

export interface EditionProfile {
  /**
   * The currency new money documents are issued in and every total is
   * reported in. IRR is the storage unit of the Iranian edition and is still
   * DISPLAYED as Toman there, as it always was.
   */
  currency: 'IRR' | 'USD';
  calendar: 'jalali' | 'gregorian';
  /** Default phone country (ISO 3166-1 alpha-2); null = no national default. */
  phoneCountry: 'IR' | null;
  /** Iranian payment gateways, SMS, CDN and storage vendors may be listed/used. */
  allowsIranianProviders: boolean;
  /** The Rial wallet (deposits, pay-from-wallet). Off until a USD ledger exists. */
  wallet: boolean;
  /** Buying AI credit with Rial. Off until a USD ledger exists. */
  aiCreditTopup: boolean;
}

export const EDITION_PROFILE: Readonly<Record<Edition, Readonly<EditionProfile>>> = {
  iran: {
    currency: 'IRR',
    calendar: 'jalali',
    phoneCountry: 'IR',
    allowsIranianProviders: true,
    wallet: true,
    aiCreditTopup: true,
  },
  international: {
    currency: 'USD',
    calendar: 'gregorian',
    phoneCountry: null,
    allowsIranianProviders: false,
    wallet: false,
    aiCreditTopup: false,
  },
};

export function editionCurrency(edition: Edition): 'IRR' | 'USD' {
  return EDITION_PROFILE[edition].currency;
}

// ─── Iranian providers ─────────────────────────────────────────────────────

/**
 * Iranian one-time payment gateways (the server's former `IRAN_PROVIDERS`):
 * their checkout amount is fully server-derived and charged in Rial. The
 * internal simulated gateway follows the same redirect + intent contract and
 * its bank page is a Toman page, so it belongs to the Iranian edition too.
 */
export const IRANIAN_PAYMENT_PROVIDERS = [
  'zarinpal',
  'zarinpal_test',
  'idpay',
  'idpay_test',
  'iranpardakht_sandbox',
  'nextpay',
  'payping',
  'zibal',
  'sep_shaparak',
  'internal_test',
] as const;

/** Other spellings of the same gateways used by older admin catalogues. */
const IRANIAN_PAYMENT_PROVIDER_ALIASES = ['sep'] as const;

/** Iranian SMS, CDN and object-storage vendors (src/features/providers/schemas.ts). */
export const IRANIAN_SMS_PROVIDERS = ['kavenegar', 'melipayamak', 'ghasedak', 'farazsms', 'smsir', 'payamresan'] as const;
export const IRANIAN_CDN_PROVIDERS = ['arvancloud', 'iranserver_cdn', 'parspack_cdn', 'derakcloud'] as const;
export const IRANIAN_STORAGE_PROVIDERS = ['arvan_storage'] as const;

const IRANIAN_PAYMENT_SET = new Set<string>([...IRANIAN_PAYMENT_PROVIDERS, ...IRANIAN_PAYMENT_PROVIDER_ALIASES]);
const IRANIAN_VENDOR_SET = new Set<string>([
  ...IRANIAN_PAYMENT_SET,
  ...IRANIAN_SMS_PROVIDERS,
  ...IRANIAN_CDN_PROVIDERS,
  ...IRANIAN_STORAGE_PROVIDERS,
]);

function vendorKey(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

export function isIranianPaymentProvider(provider: unknown): boolean {
  return IRANIAN_PAYMENT_SET.has(vendorKey(provider));
}

/** Any Iranian vendor: payment gateway, SMS, CDN or object storage. */
export function isIranianVendor(vendor: unknown): boolean {
  return IRANIAN_VENDOR_SET.has(vendorKey(vendor));
}

/** May this provider (payment gateway or other vendor) be listed or used in this edition? */
export function isProviderAllowedInEdition(provider: unknown, edition: Edition): boolean {
  if (EDITION_PROFILE[edition].allowsIranianProviders) return true;
  return !isIranianVendor(provider);
}

// ─── Currencies ────────────────────────────────────────────────────────────

/** Every code the platform has used for Rial / Toman amounts. */
export const RIAL_CURRENCY_CODES = ['IRR', 'IRT', 'RIAL', 'TOMAN', 'TMN'] as const;
const RIAL_SET = new Set<string>(RIAL_CURRENCY_CODES);

export function isRialCurrency(code: unknown): boolean {
  return typeof code === 'string' && RIAL_SET.has(code.trim().toUpperCase());
}

/** May money in this currency be priced, charged or offered in this edition? */
export function isCurrencyAllowedInEdition(code: unknown, edition: Edition): boolean {
  if (edition === 'iran') return true;
  return !isRialCurrency(code);
}

// ─── Region modes and their currency ───────────────────────────────────────

/** `platform_settings.region_mode` values (src/lib/region.ts, server/services/platformRegion.ts). */
export const REGION_MODES = ['multi', 'iran', 'turkey', 'global'] as const;
export type RegionMode = (typeof REGION_MODES)[number];

/** A stored region mode, or `multi` (the column default) when it is not one. */
export function parseRegionMode(value: unknown): RegionMode {
  return typeof value === 'string' && (REGION_MODES as readonly string[]).includes(value) ? (value as RegionMode) : 'multi';
}

/** The currency a region shows and charges in (ISO 4217; IRR is displayed as Toman). */
export type RegionCurrency = 'IRR' | 'TRY' | 'USD';

/**
 * The display and charge currency per region mode (the owner's rule):
 *   - `iran`   → IRR (Toman), exactly as before;
 *   - `turkey` → TRY: a Turkish-only site sells in Turkish Lira;
 *   - `multi`, `global` → USD for EVERY language, Turkish and Persian included.
 * The UI language never chooses the currency.
 */
export const REGION_CURRENCY: Readonly<Record<RegionMode, RegionCurrency>> = {
  iran: 'IRR',
  turkey: 'TRY',
  multi: 'USD',
  global: 'USD',
};

/** `platform_settings.region_mode` → the currency it shows and charges (missing/unknown → `multi` → USD). */
export function editionCurrencyFor(regionMode: unknown): RegionCurrency {
  return REGION_CURRENCY[parseRegionMode(regionMode)];
}

/**
 * The currency for an edition plus the region mode the platform reported.
 * The edition wins when the two disagree (an `iran` edition is always IRR;
 * an International edition is never IRR, even with a stale `iran` mode).
 */
export function currencyForEditionRegion(edition: Edition, regionMode: unknown): RegionCurrency {
  if (edition === 'iran') return 'IRR';
  const mode = parseRegionMode(regionMode);
  return mode === 'iran' ? editionCurrency(edition) : REGION_CURRENCY[mode];
}

/**
 * Whether a region pins its catalogue to its own currency. `multi` and
 * `global` show and charge USD only (plus the currency a running paid period
 * was bought in, so that customer can still upgrade); `iran` and `turkey`
 * keep offering every currency the edition allows, their own first.
 */
export function regionPinsCurrency(regionMode: unknown): boolean {
  const mode = parseRegionMode(regionMode);
  return mode === 'multi' || mode === 'global';
}

// ─── Iranian-only services ─────────────────────────────────────────────────

/** Bale (بله), the Iranian messenger: a channel of the Iranian edition only. */
export const IRANIAN_CHANNELS = ['bale'] as const;

export function isIranianChannel(id: unknown): boolean {
  return typeof id === 'string' && (IRANIAN_CHANNELS as readonly string[]).includes(id.trim().toLowerCase());
}

/** May this channel / plugin be listed or used in this edition? */
export function isChannelAllowedInEdition(id: unknown, edition: Edition): boolean {
  return EDITION_PROFILE[edition].allowsIranianProviders || !isIranianChannel(id);
}

/** The default time zone of each edition: Tehran in Iran, UTC elsewhere (or the browser's on the client). */
export function editionDefaultTimeZone(edition: Edition): 'Asia/Tehran' | 'UTC' {
  return edition === 'iran' ? 'Asia/Tehran' : 'UTC';
}

/**
 * SMS one-time codes (phone verification and the gates that require it).
 * The only live SMS runtimes are Iranian (Kavenegar, SMS.ir), so outside the
 * Iranian edition SMS verification is unavailable: hidden, never required.
 */
export function smsVerificationAvailable(edition: Edition): boolean {
  return EDITION_PROFILE[edition].allowsIranianProviders;
}
