// Which gateways a workspace may pay its account with (simple billing).
//
// A gateway is listed when it is active in Super Admin → Finance → Gateways,
// allowed in the edition, configured for the account's currency, able to
// charge that currency, and able to CONFIRM a payment from the server
// (a verifyPayment lookup): the Iranian gateways in IRR, Paddle / Stripe /
// PayPal in the currencies they charge. The Paddle sandbox is shown to
// platform admins only unless its settings open it to customers.

import type { ServerConfig } from '../../../config.js';
import { getProvider, resolveNamedBillingConfig } from '../index.js';
import { listPayableGateways, type Gateway } from '../config/index.js';
import { normalizeCurrencyCode } from '../providers/minorAmount.js';
import { paddleSandboxOpenToCustomers } from '../providers/paddle-sandbox.js';
import { IRANIAN_PAYMENT_PROVIDERS, isCurrencyAllowedInEdition, isProviderAllowedInEdition, type Edition } from '../../../../shared/edition.js';
import { PADDLE_SANDBOX_PROVIDER } from '../../../../shared/testGateways.js';
import type { GatewayListing, GatewayListingReason } from '../../../../shared/simpleBillingAdmin.js';
import type { BillingProviderConfig, BillingProviderHandler } from '../types.js';

const IRANIAN = new Set<string>(IRANIAN_PAYMENT_PROVIDERS);

/** Card gateways whose payment the server can look up (no webhook-only ones). */
const CARD_ACCOUNT_PROVIDERS = new Set(['paddle', 'paddle_sandbox', 'stripe', 'paypal']);

export function isIranianGateway(providerName: string): boolean {
  return IRANIAN.has(providerName);
}

/** Whether this gateway can charge `currency` for an account payment (and, given its config, this account can). */
export function canChargeAccount(providerName: string, currency: string, config?: BillingProviderConfig | null): boolean {
  const code = normalizeCurrencyCode(currency);
  if (!code) return false;
  const provider = getProvider(providerName);
  if (!provider?.verifyPayment) return false;
  if (IRANIAN.has(providerName)) return code === 'IRR';
  if (!CARD_ACCOUNT_PROVIDERS.has(providerName)) return false;
  if (!provider.supportedCurrencies?.includes(code)) return false;
  if (config && provider.chargeableCurrencies) return provider.chargeableCurrencies(config).includes(code);
  return true;
}

export interface GatewayViewer {
  isPlatformAdmin: boolean;
}

async function resolve(cfg: ServerConfig, workspaceId: string, providerName: string) {
  return resolveNamedBillingConfig(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, workspaceId, providerName).catch(() => null);
}

/** Whether listing this gateway depends on its resolved settings (the sandbox switch, or the currencies they charge). */
export function gatewayNeedsConfig(providerName: string): boolean {
  return providerName === PADDLE_SANDBOX_PROVIDER || Boolean(getProvider(providerName)?.chargeableCurrencies);
}

/**
 * The one rule for "is this gateway listed for an account in `currency`",
 * with every reason it is not (shared/simpleBillingAdmin.ts). `config` is
 * the gateway's resolved settings: null when they could not be read,
 * undefined when not read yet (the checks that need them are skipped). `edition`
 * null: the caller already kept only gateways of the edition and currency
 * (listPayableGateways).
 */
export function gatewayListing(
  gateway: Pick<Gateway, 'provider_name' | 'is_active' | 'currencies'> & { implemented?: boolean },
  currency: string,
  config: BillingProviderConfig | null | undefined,
  edition: Edition | null,
  viewer: GatewayViewer = { isPlatformAdmin: false },
): GatewayListing {
  const name = gateway.provider_name;
  const code = normalizeCurrencyCode(currency) ?? '';
  const reasons: GatewayListingReason[] = [];
  const add = (reason: GatewayListingReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (edition && (!isProviderAllowedInEdition(name, edition) || !isCurrencyAllowedInEdition(code, edition))) add('not_in_edition');
  if (!gateway.is_active || gateway.implemented === false) add('inactive');
  const configured = gateway.currencies ?? [];
  if (configured.length > 0 && !configured.includes(code) && !configured.includes(currency)) add('currency');
  const provider = getProvider(name);
  if (!provider?.verifyPayment) {
    add('cannot_confirm');
  } else if (!canChargeAccount(name, code)) {
    // An Iranian gateway outside IRR, or a card gateway that does not take this
    // currency, is a currency problem; any other gateway cannot be confirmed here.
    add(IRANIAN.has(name) || CARD_ACCOUNT_PROVIDERS.has(name) ? 'currency' : 'cannot_confirm');
  } else if (gatewayNeedsConfig(name) && config !== undefined) {
    if (config === null) {
      add('cannot_confirm');
    } else {
      if (name === PADDLE_SANDBOX_PROVIDER && !viewer.isPlatformAdmin && !paddleSandboxOpenToCustomers(config)) add('test');
      if (!canChargeAccount(name, code, config)) add('currency');
    }
  }
  return { listed: reasons.length === 0, reasons };
}

/** The gateways this viewer may pay an account in `currency` with, in Super Admin's order. */
export async function accountGateways(
  cfg: ServerConfig,
  workspaceId: string,
  currency: string,
  viewer: GatewayViewer,
): Promise<Gateway[]> {
  const gateways = await listPayableGateways(cfg, currency);
  const usable = await Promise.all(
    gateways.map(async (g) => {
      // Settings are read only when they decide, and only for a gateway that passed everything else.
      const first = gatewayListing(g, currency, undefined, null, viewer);
      if (!first.listed || !gatewayNeedsConfig(g.provider_name)) return first.listed;
      const resolved = await resolve(cfg, workspaceId, g.provider_name);
      return gatewayListing(g, currency, resolved?.config ?? null, null, viewer).listed;
    }),
  );
  return gateways.filter((_g, i) => usable[i]);
}

/**
 * The gateway a checkout runs on: the customer's pick, re-validated against
 * the list above (a crafted request cannot reach a disabled or unlisted
 * provider), else the first listed one.
 */
export async function resolveAccountGateway(
  cfg: ServerConfig,
  workspaceId: string,
  currency: string,
  providerName: string | null | undefined,
  viewer: GatewayViewer,
): Promise<{ provider: BillingProviderHandler; config: BillingProviderConfig } | null> {
  const gateways = await accountGateways(cfg, workspaceId, currency, viewer);
  const chosen = providerName ? gateways.find((g) => g.provider_name === providerName) : gateways[0];
  if (!chosen) return null;
  const resolved = await resolve(cfg, workspaceId, chosen.provider_name);
  if (!resolved || resolved.provider.name !== chosen.provider_name) return null;
  return resolved;
}
