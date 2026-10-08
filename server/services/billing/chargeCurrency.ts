// ============================================================
// CHARGE CURRENCY — which of a plan's prices a gateway is asked to charge.
//
// `billing_plans.prices` holds one amount per currency. A gateway may only be
// sent an amount under the code it was priced in: a USD price must never
// reach a gateway labelled TRY (or the other way round). So the currency is
// decided BEFORE the price is read:
//
//   * the requested currency, when the gateway charges it;
//   * otherwise the gateway's fallback currency (Turkish gateways: TRY), and
//     then the plan's price IN THAT currency is charged — explicitly, never
//     the requested currency's number;
//   * otherwise the checkout is refused.
//
// A provider without a declared currency list keeps its previous behaviour.
// ============================================================

import type { BillingProviderHandler } from './types.js';
import { normalizeCurrencyCode } from './providers/minorAmount.js';

/** The currency to charge, or null when the gateway cannot charge this checkout at all (CURRENCY_NOT_SUPPORTED). */
export interface ChargeCurrency {
  currency: string;
  /** True when the requested currency was replaced by the gateway's fallback. */
  fellBack: boolean;
}

export function resolveChargeCurrency(
  provider: Pick<BillingProviderHandler, 'supportedCurrencies' | 'fallbackCurrency'>,
  requested: string | null | undefined,
): ChargeCurrency | null {
  const code = normalizeCurrencyCode(requested);
  const supported = provider.supportedCurrencies;
  if (!supported) return code ? { currency: code, fellBack: false } : null;
  if (code && supported.includes(code)) return { currency: code, fellBack: false };
  const fallback = normalizeCurrencyCode(provider.fallbackCurrency);
  if (fallback && supported.includes(fallback)) return { currency: fallback, fellBack: true };
  return null;
}
