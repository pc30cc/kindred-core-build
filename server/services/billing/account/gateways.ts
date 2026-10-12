// Which gateways a workspace may pay its account with (simple billing).
//
// A gateway is listed when it is active in Super Admin → Finance → Gateways,
// allowed in the edition, configured for the account's currency, able to
// charge that currency, able to CONFIRM a payment from the server
// (a verifyPayment lookup): the Iranian gateways in IRR, Paddle / Stripe /
// PayPal in the currencies they charge, and set up with everything a
// payment needs (SETTINGS_CHECKS). A gateway whose settings put it in the
// provider's test mode (a Stripe test key, a sandbox switch) is shown, like
// the test gateways, to platform admins only. Test gateways (ZarinPal test, the
// internal simulator, …) are shown to platform admins only; the Paddle
// sandbox too, unless its settings open it to customers.

import type { ServerConfig } from '../../../config.js';
import { getProvider, resolveNamedBillingConfig } from '../index.js';
import { listPayableGateways, type Gateway } from '../config/index.js';
import { normalizeCurrencyCode } from '../providers/minorAmount.js';
import { paddleSandboxOpenToCustomers } from '../providers/paddle-sandbox.js';
import { isPaddleSandboxFlag, paddleSettingsProblem } from '../providers/paddle.js';
import { zarinpalSettingsProblem } from '../providers/zarinpal.js';
import { zibalSettingsProblem } from '../providers/zibal.js';
import { paypingSettingsProblem } from '../providers/payping.js';
import { nextpaySettingsProblem } from '../providers/nextpay.js';
import { sepSettingsProblem } from '../providers/sep.js';
import { idpaySettingsProblem } from '../providers/idpay.js';
import { stripeSettingsProblem, stripeTestMode } from '../providers/stripe.js';
import { paypalSettingsProblem, paypalTestMode } from '../providers/paypal.js';
import { lemonSqueezySettingsProblem, lemonSqueezyTestMode } from '../providers/lemonsqueezy.js';
import { iyzicoSettingsProblem, iyzicoTestMode } from '../providers/iyzico.js';
import { paytrSettingsProblem, paytrTestMode } from '../providers/paytr.js';
import { sipaySettingsProblem } from '../providers/sipay.js';
import { paratikaSettingsProblem } from '../providers/paratika.js';
import { craftgateSettingsProblem, craftgateTestMode } from '../providers/craftgate.js';
import { IRANIAN_PAYMENT_PROVIDERS, isCurrencyAllowedInEdition, isProviderAllowedInEdition, type Edition } from '../../../../shared/edition.js';
import { PADDLE_SANDBOX_PROVIDER, isTestPaymentProvider } from '../../../../shared/testGateways.js';
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

/**
 * What a gateway's settings lack for it to take a payment, or null: the
 * credentials it needs (named as the Providers screen names them), and a
 * credential of the wrong kind (a sandbox merchant or key on a live gateway).
 * An active gateway with a problem is not listed (`not_configured`).
 */
const SETTINGS_CHECKS: Record<string, (config: BillingProviderConfig) => string | null> = {
  zarinpal: (config) => zarinpalSettingsProblem(config),
  paddle: (config) => paddleSettingsProblem(config, 'paddle'),
  [PADDLE_SANDBOX_PROVIDER]: (config) => paddleSettingsProblem(config, PADDLE_SANDBOX_PROVIDER),
  zibal: zibalSettingsProblem,
  payping: paypingSettingsProblem,
  nextpay: nextpaySettingsProblem,
  sep_shaparak: sepSettingsProblem,
  idpay: idpaySettingsProblem,
  stripe: stripeSettingsProblem,
  paypal: paypalSettingsProblem,
  lemon_squeezy: lemonSqueezySettingsProblem,
  iyzico: iyzicoSettingsProblem,
  paytr: paytrSettingsProblem,
  sipay: sipaySettingsProblem,
  paratika: paratikaSettingsProblem,
  craftgate: craftgateSettingsProblem,
};

/**
 * Gateways whose settings can switch them to the provider's test mode (a
 * Stripe test key, PayPal's or a Turkish gateway's sandbox switch). In test
 * mode no money moves, so, like a test gateway, only platform admins are
 * offered it (`test`).
 */
const TEST_MODE_CHECKS: Record<string, (config: BillingProviderConfig) => boolean> = {
  stripe: stripeTestMode,
  paypal: paypalTestMode,
  lemon_squeezy: lemonSqueezyTestMode,
  iyzico: iyzicoTestMode,
  paytr: paytrTestMode,
  craftgate: craftgateTestMode,
};

export function gatewayTestMode(providerName: string, config: BillingProviderConfig): boolean {
  return TEST_MODE_CHECKS[providerName]?.(config) ?? false;
}

/**
 * A caveat about a gateway the Super Admin should read before switching it
 * on (shown on the readiness card), or null.
 */
const GATEWAY_NOTES: Record<string, string> = {
  idpay: 'IDPay did not answer from the production server (Canada) within 15 s in the October 2026 probe, and the service has been reported shut down. Press Test in Providers first: checkout fails after 20 s while IDPay does not answer.',
  idpay_test: 'IDPay did not answer from the production server (Canada) within 15 s in the October 2026 probe. Checkout fails after 20 s while it does not answer.',
  sep_shaparak: 'SEP (Saman) did not answer from the production server (Canada) within 15 s in the October 2026 probe: SEP answers only registered server IPs, in practice inside Iran. Press Test in Providers first: checkout fails after 20 s while SEP does not answer.',
  payping: 'PayPing charges whole Toman: a total that is not a multiple of 10 Rial is refused at checkout.',
  lemon_squeezy: 'Lemon Squeezy is confirmed only by its webhook; account payments need a server-side lookup, so it is not offered for them.',
  iyzico: 'iyzico has no server-side payment lookup in this platform yet, so it is not offered for account payments.',
  paytr: 'PayTR has no server-side payment lookup in this platform yet, so it is not offered for account payments.',
  sipay: 'Sipay has no server-side payment lookup in this platform yet, so it is not offered for account payments; its checkout request was not verified against Sipay\'s current documents.',
  paratika: 'Paratika has no server-side payment lookup in this platform yet, so it is not offered for account payments; its adapter still calls Asseco\'s integration (test) host.',
  craftgate: 'Craftgate has no server-side payment lookup in this platform yet, so it is not offered for account payments.',
};

export function gatewayNote(providerName: string): string | null {
  return GATEWAY_NOTES[providerName] ?? null;
}

export function gatewaySettingsProblem(providerName: string, config: BillingProviderConfig): string | null {
  return SETTINGS_CHECKS[providerName]?.(config) ?? null;
}

/** Whether listing this gateway depends on its resolved settings (their completeness, the sandbox switch, or the currencies they charge). */
export function gatewayNeedsConfig(providerName: string): boolean {
  return providerName === PADDLE_SANDBOX_PROVIDER
    || Object.prototype.hasOwnProperty.call(SETTINGS_CHECKS, providerName)
    || Object.prototype.hasOwnProperty.call(TEST_MODE_CHECKS, providerName)
    || Boolean(getProvider(providerName)?.chargeableCurrencies);
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
  gateway: Pick<Gateway, 'provider_name' | 'is_active' | 'currencies'> & { implemented?: boolean; config?: Record<string, unknown> | null },
  currency: string,
  config: BillingProviderConfig | null | undefined,
  edition: Edition | null,
  viewer: GatewayViewer = { isPlatformAdmin: false },
): GatewayListing {
  const name = gateway.provider_name;
  const code = normalizeCurrencyCode(currency) ?? '';
  const reasons: GatewayListingReason[] = [];
  let problem: string | null = null;
  const add = (reason: GatewayListingReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (edition && (!isProviderAllowedInEdition(name, edition) || !isCurrencyAllowedInEdition(code, edition))) add('not_in_edition');
  if (!gateway.is_active || gateway.implemented === false) add('inactive');
  // A test gateway buys a real plan with simulated money: platform admins
  // only, unless its Finance → Gateways row is opened to customers
  // (`config.open_to_customers`). The Paddle sandbox has the same switch in
  // its own settings (checked below, once they are read).
  if (isTestPaymentProvider(name) && name !== PADDLE_SANDBOX_PROVIDER && !viewer.isPlatformAdmin
      && !isPaddleSandboxFlag(gateway.config?.open_to_customers)) add('test');
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
      problem = gatewaySettingsProblem(name, config);
      if (problem) add('not_configured');
      if (name === PADDLE_SANDBOX_PROVIDER && !viewer.isPlatformAdmin && !paddleSandboxOpenToCustomers(config)) add('test');
      if (!viewer.isPlatformAdmin && gatewayTestMode(name, config)) add('test');
      if (!canChargeAccount(name, code, config)) add('currency');
    }
  }
  return { listed: reasons.length === 0, reasons, ...(problem ? { problem } : {}) };
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
