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
import { IRANIAN_PAYMENT_PROVIDERS } from '../../../../shared/edition.js';
import { PADDLE_SANDBOX_PROVIDER } from '../../../../shared/testGateways.js';
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
      if (!canChargeAccount(g.provider_name, currency)) return false;
      const needsConfig = g.provider_name === PADDLE_SANDBOX_PROVIDER || Boolean(getProvider(g.provider_name)?.chargeableCurrencies);
      if (!needsConfig) return true;
      const resolved = await resolve(cfg, workspaceId, g.provider_name);
      if (!resolved) return false;
      if (g.provider_name === PADDLE_SANDBOX_PROVIDER && !viewer.isPlatformAdmin && !paddleSandboxOpenToCustomers(resolved.config)) {
        return false;
      }
      return canChargeAccount(g.provider_name, currency, resolved.config);
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
