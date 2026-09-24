/**
 * Connector registry — the ONE place that maps a connection's provider_type
 * to what that provider is and how to talk to it. Pairing, the capability
 * handshake, guest verification and the AI stages ask this module; none of
 * them construct a provider class directly any more.
 *
 * Two provider families share the connection machinery (pairing, the
 * installation secret, signing, the SSRF-guarded gateway, permissions):
 *
 *   - `store`   — a shop. Implements the CommerceConnector contract. Either
 *                 indexed (WooCommerce: Web Yar keeps a catalogue index) or
 *                 direct (OpenCart: every read is live from the store, no
 *                 index; implements DirectCommerceConnector as well).
 *   - `billing` — an account/billing system queried live, never indexed
 *                 (WHMCS). Implements its own account contract
 *                 (shared/commerce/whmcs.ts) instead of being bent into the
 *                 order model.
 */
import { CommerceError, type CommerceConnector, type CommerceConnectorContext } from '../../../../shared/commerce/types.js';
import { WHMCS_DEFAULT_PERMISSIONS, WHMCS_PROVIDER } from '../../../../shared/commerce/whmcs.js';
import { WooCommerceConnector, type WooCommerceTransport } from './woocommerce.js';
import { WhmcsConnector } from './whmcs.js';
import { OpenCartConnector } from './opencart.js';
import { normalizeHealth } from '../whmcs/normalize.js';

export type ProviderFamily = 'store' | 'billing';

export interface ConnectionTransport {
  /** Approved origin (scheme://host[:port]). */
  origin: string;
  /** Provider base URL. WooCommerce: the origin. WHMCS: the System URL (may carry a path). */
  baseUrl: string;
  installationId: string;
  secret: string;
  /** OpenCart: the store id inside the OpenCart install (multi-store). */
  externalStoreId?: string | null;
  /** OpenCart: the platform version, which picks the route shape (3.0 vs 4.1). */
  platformVersion?: string | null;
}

export interface HandshakeResult {
  protocolVersion: string;
  connectorVersion: string | null;
  platformVersion: string | null;
  woocommerceVersion?: string | null;
  wordpressVersion?: string | null;
  hposEnabled?: boolean | null;
  capabilities: string[];
  /** Store family only: whether the store can serve its catalogue. */
  catalogReady?: boolean;
  /** Billing family only: whether the addon's schema checks passed. */
  schemaOk?: boolean;
}

export interface ProviderDescriptor {
  providerType: string;
  family: ProviderFamily;
  /** plugin_id of the workspace_plugin_installations row this provider's connections hang off. */
  pluginId: string;
  /**
   * True when Web Yar keeps a catalogue index for it (initial sync +
   * catalog_ready gate). A store-family provider without one is a DIRECT
   * store: read live per question, no sync, no background health
   * (see ../providers.ts).
   */
  usesCatalogIndex: boolean;
  /** True when the guest order path (contact match + OTP) exists for it. */
  guestOtp: boolean;
  /** Owner permission defaults written at pairing. null = keep the column default. */
  defaultPermissions: Record<string, boolean> | null;
  handshake(transport: ConnectionTransport, ctx: CommerceConnectorContext): Promise<HandshakeResult>;
}

const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  woocommerce: {
    providerType: 'woocommerce',
    family: 'store',
    pluginId: 'woocommerce',
    usesCatalogIndex: true,
    guestOtp: true,
    defaultPermissions: null,
    async handshake(transport, ctx) {
      const h = await new WooCommerceConnector(toWooTransport(transport)).negotiateCapabilities(ctx);
      return {
        protocolVersion: h.protocolVersion,
        connectorVersion: h.connectorVersion,
        platformVersion: h.woocommerceVersion,
        woocommerceVersion: h.woocommerceVersion,
        wordpressVersion: h.wordpressVersion,
        hposEnabled: h.hposEnabled,
        capabilities: h.capabilities,
        catalogReady: h.catalogReady,
      };
    },
  },
  [WHMCS_PROVIDER]: {
    providerType: WHMCS_PROVIDER,
    family: 'billing',
    pluginId: WHMCS_PROVIDER,
    usesCatalogIndex: false,
    guestOtp: false,
    defaultPermissions: { ...WHMCS_DEFAULT_PERMISSIONS },
    async handshake(transport, ctx) {
      const { data } = await new WhmcsConnector(transport).call('health', {}, {
        deadlineAt: ctx.deadlineAt,
        correlationId: ctx.correlationId,
      });
      const h = normalizeHealth(data);
      return {
        protocolVersion: h.protocolVersion,
        connectorVersion: h.addonVersion,
        platformVersion: h.whmcsVersion,
        capabilities: h.capabilities,
        schemaOk: h.schemaOk,
      };
    },
  },
  opencart: {
    providerType: 'opencart',
    family: 'store',
    pluginId: 'opencart',
    usesCatalogIndex: false,
    // Private data only for a customer signed in to the store itself.
    guestOtp: false,
    // The owner's consent screen chooses them; the column default otherwise.
    defaultPermissions: null,
    async handshake(transport, ctx) {
      // pairing.ts runs the fuller OpenCart handshake (route fallback, clone
      // guard); this is the same signed `health`, for generic callers.
      const h = await openCartConnector(transport).negotiateCapabilities(ctx);
      return {
        protocolVersion: h.protocolVersion,
        connectorVersion: h.connectorVersion,
        platformVersion: h.platformVersion,
        capabilities: h.capabilities,
      };
    },
  },
};

export function getProviderDescriptor(providerType: string): ProviderDescriptor | null {
  return DESCRIPTORS[providerType] ?? null;
}

/** Providers Web Yar keeps a catalogue index for — the only ones the sync worker touches. */
export function catalogIndexedProviders(): string[] {
  return Object.values(DESCRIPTORS).filter((d) => d.usesCatalogIndex).map((d) => d.providerType);
}

export function isKnownProvider(providerType: unknown): providerType is string {
  return typeof providerType === 'string' && Object.prototype.hasOwnProperty.call(DESCRIPTORS, providerType);
}

function openCartConnector(transport: ConnectionTransport): OpenCartConnector {
  if (!transport.baseUrl || transport.externalStoreId === null || transport.externalStoreId === undefined) {
    throw new CommerceError('commerce_not_connected', 'opencart connection has no store scope');
  }
  return new OpenCartConnector({
    origin: transport.origin,
    storeUrl: transport.baseUrl,
    externalStoreId: String(transport.externalStoreId),
    installationId: transport.installationId,
    secret: transport.secret,
    platformVersion: transport.platformVersion ?? null,
  });
}

function toWooTransport(transport: ConnectionTransport | WooCommerceTransport): WooCommerceTransport {
  return { origin: transport.origin, installationId: transport.installationId, secret: transport.secret };
}

/**
 * The catalogue/order connector for a STORE-family provider. A billing
 * provider has no CommerceConnector — asking for one is a programming error
 * that must fail loudly rather than fall back to WooCommerce.
 */
export function resolveConnector(providerType: string, transport: WooCommerceTransport | ConnectionTransport): CommerceConnector {
  switch (providerType) {
    case 'woocommerce':
      return new WooCommerceConnector(toWooTransport(transport));
    case 'opencart':
      if (!('baseUrl' in transport)) throw new CommerceError('commerce_not_connected', 'opencart connection has no store scope');
      return openCartConnector(transport);
    default:
      throw new Error(`no store connector registered for provider_type "${providerType}"`);
  }
}

export function resolveWhmcsConnector(transport: ConnectionTransport): WhmcsConnector {
  return new WhmcsConnector(transport);
}
