// ============================================================
// BILLING × EDITION — what money may look like in this edition
//
// The Iranian edition (platform_settings.region_mode = 'iran') bills exactly
// as before: IRR (shown as Toman), Iranian gateways, the Rial wallet and AI
// credit top-ups. The International edition bills in USD through
// international gateways only: an Iranian gateway is never listed, resolved
// or charged, a Rial amount is never priced or collected, and the Rial-only
// features (wallet, AI-credit top-up) answer "not available".
//
// Every check reads the edition through getPlatformEdition (cached, shared
// with the locale clamp). When the edition cannot be read at all, money paths
// fail with 503 (EditionUnavailableError) instead of guessing.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { EditionUnavailableError, getPlatformEdition } from '../platformRegion.js';
import {
  EDITION_PROFILE,
  editionCurrency,
  isCurrencyAllowedInEdition,
  isProviderAllowedInEdition,
  type Edition,
} from '../../../shared/edition.js';

export { EditionUnavailableError, getPlatformEdition, isCurrencyAllowedInEdition, isProviderAllowedInEdition };
export type { Edition };

type DbConfig = Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>;

/** A request the edition does not allow: an Iranian gateway or Rial in International, a Rial-only feature. */
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

/** The currency new documents default to: IRR in the Iranian edition, USD in the International one. */
export async function billingEditionCurrency(config: DbConfig): Promise<'IRR' | 'USD'> {
  return editionCurrency(await getPlatformEdition(config));
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
 * Guard for creating a payment attempt or invoice: the gateway and the
 * currency must both belong to this edition. In the Iranian edition every
 * provider and currency stays allowed (no change from before).
 */
export async function assertPaymentAllowedInEdition(
  config: DbConfig,
  input: { provider?: string | null; currency?: string | null },
): Promise<Edition> {
  const edition = await getPlatformEdition(config);
  assertProviderAllowed(edition, input.provider);
  assertCurrencyAllowed(edition, input.currency);
  return edition;
}

/** The currency to issue in: the requested one (if the edition allows it), else the edition's. */
export async function resolveEditionCurrency(config: DbConfig, requested?: string | null): Promise<string> {
  const edition = await getPlatformEdition(config);
  const code = typeof requested === 'string' ? requested.trim().toUpperCase() : '';
  const currency = /^[A-Z]{3}$/.test(code) ? code : editionCurrency(edition);
  assertCurrencyAllowed(edition, currency);
  return currency;
}

export type EditionFeature = 'wallet' | 'aiCreditTopup';

/** Refuses a Rial-only feature outside the Iranian edition. */
export async function assertEditionFeature(config: DbConfig, feature: EditionFeature): Promise<Edition> {
  const edition = await getPlatformEdition(config);
  if (!EDITION_PROFILE[edition][feature]) {
    throw new EditionPolicyError('FEATURE_NOT_AVAILABLE_IN_EDITION', 403, { feature, edition });
  }
  return edition;
}

/** Keeps only the gateways/providers this edition may list. */
export function filterProvidersForEdition<T>(rows: T[], edition: Edition, nameOf: (row: T) => string): T[] {
  return rows.filter((row) => isProviderAllowedInEdition(nameOf(row), edition));
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
