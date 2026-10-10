/**
 * Presentation helpers for the simple billing screens. Nothing here computes
 * money; it only turns server values into labels.
 */
import type { TranslationKey } from '@/i18n';
import { planPriceDecimals, planPriceFactor, planPriceToDisplay } from '@/lib/planPrice';

/** Server error → translated message, with the gateway's own reason when it refused a checkout. */
export function accountErrorText(e: unknown, t: (k: TranslationKey) => string): string {
  const err = e as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'CHECKOUT_PROVIDER_ERROR') {
    const details = (err?.details ?? null) as { providerMessage?: unknown } | null;
    const reason = typeof details?.providerMessage === 'string' ? details.providerMessage.trim() : '';
    const label = t('billing.account.errors.CHECKOUT_PROVIDER_ERROR');
    return reason ? `${label} ${reason}` : label;
  }
  if (/^[A-Z_]+$/.test(code)) {
    const key = `billing.account.errors.${code}` as TranslationKey;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return t('billing.account.errors.generic');
}

/**
 * The public app origin the gateway returns to. In development behind a
 * preview proxy it is the deployed app origin (callbacks to a temporary host
 * are refused), like the invoice payment page.
 */
export function billingReturnOrigin(): string {
  if (!import.meta.env.DEV) return window.location.origin;
  const configured = import.meta.env.VITE_PREVIEW_PROXY_ORIGIN?.trim();
  const apiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');
  const candidate = configured || apiBase?.replace('://api.', '://app.');
  if (!candidate) return window.location.origin;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/** Quick top-up amounts per currency, in the units people read (Toman, dollars, lira). */
export const QUICK_TOPUPS: Readonly<Record<string, readonly number[]>> = {
  IRR: [200_000, 500_000, 1_000_000, 2_000_000],
  USD: [10, 25, 50, 100],
  TRY: [250, 500, 1_000, 2_500],
  EUR: [10, 25, 50, 100],
  GBP: [10, 25, 50, 100],
};

/** A stored amount as the number people type (Toman for IRR, major units elsewhere). */
export function toDisplayAmount(minor: number, currency: string): number {
  return planPriceToDisplay(minor, currency);
}

/** What people typed (Toman / major units) as stored minor units; null when not a whole minor amount. */
export function toMinorAmount(display: number, currency: string): number | null {
  if (!Number.isFinite(display) || display <= 0) return null;
  const decimals = planPriceDecimals(currency);
  const factor = planPriceFactor(currency);
  const scaled = Math.round(display * 10 ** decimals) / 10 ** decimals;
  return Math.round(scaled * factor);
}

/** The label of a gateway in this locale. */
export function gatewayLabel(displayName: Record<string, string> | null | undefined, provider: string, locale: string): string {
  const names = displayName ?? {};
  return names[locale] || names.en || names.fa || provider;
}

/** The plan's name in this locale (billing_plans.localized), else its stored name. */
export function planLabel(name: string | null, localized: Record<string, unknown> | null | undefined, locale: string): string {
  const entry = localized?.[locale];
  if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
    const n = (entry as { name: string }).name.trim();
    if (n) return n;
  }
  return name || '';
}
