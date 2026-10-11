/**
 * AI credit packs of the simple billing (phase 5, migration 264;
 * docs/billing/SIMPLE_BILLING.md): rules shared by the server and the
 * browser. Pure: no I/O.
 *
 * A pack is sold in the account currency: `price_minor` is what the balance
 * pays, `credit_minor` the AI credit it buys, both in minor units of that
 * same currency (Rial / cent / kuruş), so "$5 buys $6 of AI credit". The AI
 * wallet itself counts in IRR: the credit is converted at purchase time with
 * the rate the meter charges with (billing_ai_wallet_rate), and shown back in
 * the account currency (walletToMinor). Packs live in
 * billing_settings.ai_packs, per edition row, keyed by currency.
 */

import type { Edition } from './edition.js';
import { TOPUP_LIMITS } from './simpleBilling.js';

export type AiPackLocale = 'fa' | 'en' | 'tr';

export interface AiPack {
  /** Unique per currency; never changes once saved (purchases name it). */
  id: string;
  /** What the balance pays, in minor units of the pack's currency. */
  price_minor: number;
  /** The AI credit bought, in minor units of the same currency. */
  credit_minor: number;
  /** Offered while true (the default). */
  active?: boolean;
  label?: Partial<Record<AiPackLocale, string>>;
}

/** The currencies whose packs each edition's Super Admin sets (the VAT currencies). */
export const AI_PACK_CURRENCIES: Readonly<Record<Edition, readonly string[]>> = {
  iran: ['IRR'],
  international: ['USD', 'TRY'],
};

export const AI_PACK_LOCALES: readonly AiPackLocale[] = ['fa', 'en', 'tr'];

/** Decision D16 of the phase 5 design. */
export const AI_PACK_LIMITS = {
  /** Packs per currency. */
  maxPerCurrency: 8,
  idPattern: /^[a-z0-9][a-z0-9_-]{0,23}$/,
  /** The largest credit of one pack, in minor units. */
  maxCreditMinor: 1_000_000_000_000,
  /** A label, per language. */
  maxLabelLength: 40,
  /** IRR prices are whole Toman (a multiple of 10 Rial). */
  irrPriceStep: 10,
} as const;

/** The largest price of one pack: the largest top-up of its currency. */
export function maxPackPriceMinor(currency: string): number | null {
  return TOPUP_LIMITS[currency.toUpperCase()]?.max ?? null;
}

/** Decimal places of a currency's minor unit (IRR is kept in whole Rial). */
export function currencyExponent(currency: string): number {
  return currency.toUpperCase() === 'IRR' ? 0 : 2;
}

export type AiPacksProblem = 'invalid' | 'duplicate' | 'too_many' | 'currency';

export type AiPacksValidation =
  | { ok: true; packs: Record<string, AiPack[]> }
  | { ok: false; error: 'AI_PACKS_INVALID'; field: string; reason: AiPacksProblem };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
}

/**
 * Validates the packs Super Admin saves for an edition and returns them
 * normalised: every edition currency present (an empty list when none),
 * labels trimmed (empty ones dropped), `active` explicit. `field` names what
 * is wrong, e.g. `USD`, `USD.1.price_minor`, `IRR.0.label.fa`.
 */
export function validateAiPacks(raw: unknown, edition: Edition): AiPacksValidation {
  const bad = (field: string, reason: AiPacksProblem = 'invalid'): AiPacksValidation => ({ ok: false, error: 'AI_PACKS_INVALID', field, reason });
  if (!isRecord(raw)) return bad('packs');
  const currencies = AI_PACK_CURRENCIES[edition];
  for (const key of Object.keys(raw)) {
    if (!currencies.includes(key)) return bad(key, 'currency');
  }
  const out: Record<string, AiPack[]> = {};
  for (const currency of currencies) {
    const list = raw[currency] ?? [];
    if (!Array.isArray(list)) return bad(currency);
    if (list.length > AI_PACK_LIMITS.maxPerCurrency) return bad(currency, 'too_many');
    const maxPrice = maxPackPriceMinor(currency) ?? 0;
    const seen = new Set<string>();
    const packs: AiPack[] = [];
    for (let i = 0; i < list.length; i++) {
      const at = `${currency}.${i}`;
      const item = list[i];
      if (!isRecord(item)) return bad(at);
      const id = typeof item.id === 'string' ? item.id : '';
      if (!AI_PACK_LIMITS.idPattern.test(id)) return bad(`${at}.id`);
      if (seen.has(id)) return bad(`${at}.id`, 'duplicate');
      seen.add(id);
      if (!isPositiveInt(item.price_minor, maxPrice)) return bad(`${at}.price_minor`);
      if (currency === 'IRR' && item.price_minor % AI_PACK_LIMITS.irrPriceStep !== 0) return bad(`${at}.price_minor`);
      if (!isPositiveInt(item.credit_minor, AI_PACK_LIMITS.maxCreditMinor)) return bad(`${at}.credit_minor`);
      if (item.active !== undefined && typeof item.active !== 'boolean') return bad(`${at}.active`);
      const pack: AiPack = { id, price_minor: item.price_minor, credit_minor: item.credit_minor, active: item.active !== false };
      if (item.label !== undefined && item.label !== null) {
        if (!isRecord(item.label)) return bad(`${at}.label`);
        const label: Partial<Record<AiPackLocale, string>> = {};
        for (const key of Object.keys(item.label)) {
          if (!(AI_PACK_LOCALES as readonly string[]).includes(key)) return bad(`${at}.label.${key}`);
          const value = item.label[key];
          if (value === undefined || value === null) continue;
          if (typeof value !== 'string') return bad(`${at}.label.${key}`);
          const trimmed = value.trim();
          if (trimmed.length > AI_PACK_LIMITS.maxLabelLength) return bad(`${at}.label.${key}`);
          if (trimmed) label[key as AiPackLocale] = trimmed;
        }
        if (Object.keys(label).length) pack.label = label;
      }
      packs.push(pack);
    }
    out[currency] = packs;
  }
  return { ok: true, packs: out };
}

/**
 * The packs offered in a currency: active and well formed, in their saved
 * order. Reads the stored value defensively, the way the SQL finds a pack
 * (billing_ai_pack_find): a malformed entry is never offered.
 */
export function activePacks(all: unknown, currency: string): AiPack[] {
  if (!isRecord(all)) return [];
  const list = all[currency.toUpperCase()];
  if (!Array.isArray(list)) return [];
  const out: AiPack[] = [];
  for (const item of list) {
    if (!isRecord(item) || item.active === false) continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id || out.some((p) => p.id === id)) continue;
    if (!isPositiveInt(item.price_minor, Number.MAX_SAFE_INTEGER) || !isPositiveInt(item.credit_minor, Number.MAX_SAFE_INTEGER)) continue;
    const pack: AiPack = { id, price_minor: item.price_minor, credit_minor: item.credit_minor, active: true };
    if (isRecord(item.label)) {
      const label: Partial<Record<AiPackLocale, string>> = {};
      for (const locale of AI_PACK_LOCALES) {
        const value = item.label[locale];
        if (typeof value === 'string' && value.trim()) label[locale] = value.trim();
      }
      if (Object.keys(label).length) pack.label = label;
    }
    out.push(pack);
  }
  return out;
}

/** A pack's name in a language, else `fallback`. */
export function packLabel(pack: Pick<AiPack, 'label'> | null | undefined, locale: string, fallback: string): string {
  const own = pack?.label?.[locale.toLowerCase().split('-')[0] as AiPackLocale];
  return typeof own === 'string' && own.trim() ? own.trim() : fallback;
}

/**
 * AI wallet units (IRR) shown in a currency's minor units: rounded down, so
 * the page never shows more credit than there is. null without a rate.
 * `rate` is wallet units per ONE MAJOR unit of the currency.
 */
export function walletToMinor(wallet: number, rate: number | null | undefined, currency: string): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(wallet)) return null;
  // The epsilon absorbs binary noise (0.29 * 100 = 28.999…), never a real fraction of a minor unit.
  const value = Math.floor((wallet * 10 ** currencyExponent(currency)) / rate + 1e-9);
  return Math.max(value, 0);
}

/** What a pack's credit adds to the AI wallet (IRR), as the SQL computes it; null without a rate. */
export function creditToWallet(creditMinor: number, rate: number | null | undefined, currency: string): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((creditMinor / 10 ** currencyExponent(currency)) * rate);
}

/** The bonus a pack gives over its price, in whole percent (rounded down); 0 when none. */
export function bonusPercent(pack: Pick<AiPack, 'price_minor' | 'credit_minor'>): number {
  if (!(pack.price_minor > 0) || !(pack.credit_minor > pack.price_minor)) return 0;
  return Math.floor(((pack.credit_minor - pack.price_minor) * 100) / pack.price_minor);
}
