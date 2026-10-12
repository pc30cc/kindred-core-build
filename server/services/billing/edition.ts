// ============================================================
// BILLING × EDITION — what money may look like in this edition
//
// The Iranian edition (platform_settings.region_mode = 'iran') bills in IRR
// (shown as Toman) through Iranian gateways. The International edition bills
// in its region's currency (USD or TRY) through international gateways only:
// an Iranian gateway is never listed, resolved or charged, and a Rial amount
// is never priced or collected.
//
// Every check reads the edition through getPlatformEdition (cached, shared
// with the locale clamp). When the edition cannot be read at all, money paths
// fail with 503 (EditionUnavailableError) instead of guessing.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { EditionUnavailableError, getPlatformEdition, getPlatformRegionMode } from '../platformRegion.js';
import {
  currencyForEditionRegion,
  isCurrencyAllowedInEdition,
  isProviderAllowedInEdition,
  type Edition,
  type RegionCurrency,
  type RegionMode,
} from '../../../shared/edition.js';

export { EditionUnavailableError, getPlatformEdition, getPlatformRegionMode, isCurrencyAllowedInEdition, isProviderAllowedInEdition };
export type { Edition, RegionCurrency, RegionMode };

type DbConfig = Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>;

/** A request the edition does not allow: an Iranian gateway or Rial in International. */
export class EditionPolicyError extends Error {
  constructor(
    public code: 'PROVIDER_NOT_AVAILABLE_IN_EDITION' | 'CURRENCY_NOT_AVAILABLE_IN_EDITION' | 'FEATURE_NOT_AVAILABLE_IN_EDITION',
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'EditionPolicyError';
  }
}

/** The edition, the region mode and the currency that region shows and charges (shared/edition.ts). */
export interface BillingRegion {
  edition: Edition;
  regionMode: RegionMode;
  currency: RegionCurrency;
}

export async function getBillingRegion(config: DbConfig): Promise<BillingRegion> {
  const edition = await getPlatformEdition(config);
  // The Iranian edition IS region `iran` (Rial): nothing more to read.
  if (edition === 'iran') return { edition, regionMode: 'iran', currency: 'IRR' };
  // Same cached read as the edition; should it still fail, Multi Region (USD).
  const regionMode = await getPlatformRegionMode(config).catch(() => 'multi' as const);
  return { edition, regionMode, currency: currencyForEditionRegion(edition, regionMode) };
}

/**
 * The currency new documents default to: IRR in the Iranian edition (as
 * before), TRY on a Turkish-only site, USD in Multi Region and Global.
 */
export async function billingEditionCurrency(config: DbConfig): Promise<RegionCurrency> {
  return (await getBillingRegion(config)).currency;
}

export function assertProviderAllowed(edition: Edition, provider: string | null | undefined): void {
  if (provider && !isProviderAllowedInEdition(provider, edition)) {
    throw new EditionPolicyError('PROVIDER_NOT_AVAILABLE_IN_EDITION', 400, { provider, edition });
  }
}

export function assertCurrencyAllowed(edition: Edition, currency: string | null | undefined): void {
  if (currency && !isCurrencyAllowedInEdition(currency, edition)) {
    throw new EditionPolicyError('CURRENCY_NOT_AVAILABLE_IN_EDITION', 400, {
      currency: currency.toUpperCase(),
      edition,
    });
  }
}

/**
 * The HTTP answer for an edition error, or null when `e` is something else.
 * Routes call this first in their catch blocks.
 */
export function editionErrorResponse(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof EditionUnavailableError) {
    return { status: e.status, body: { error: e.code } };
  }
  if (e instanceof EditionPolicyError) {
    return { status: e.status, body: { error: e.code, details: e.details } };
  }
  return null;
}
