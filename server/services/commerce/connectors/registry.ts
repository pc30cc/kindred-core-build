/**
 * Connector registry — the ONE place that maps a connection's provider_type
 * to what that provider is and how to talk to it. Pairing, the capability
 * handshake, guest verification and the AI stages ask this module; none of
 * them construct a provider class directly any more.
 *
 * Two provider families share the connection machinery (pairing, the
 * installation secret, signing, the SSRF-guarded gateway, permissions):
 *
 *   - `store`   — a shop with a product catalogue Web Yar indexes
 *                 (WooCommerce). Implements the CommerceConnector contract.
 *   - `billing` — an account/billing system queried live, never indexed
 *                 (WHMCS). Implements its own account contract
 *                 (shared/commerce/whmcs.ts) instead of being bent into the
 *                 order model.
 */
import type { CommerceConnector, CommerceConnectorContext } from '../../../../shared/commerce/types.js';
import { WHMCS_DEFAULT_PERMISSIONS, WHMCS_PROVIDER } from '../../../../shared/commerce/whmcs.js';
import { WooCommerceConnector, type WooCommerceTransport } from './woocommerce.js';
import { WhmcsConnector } from './whmcs.js';
import { normalizeHealth } from '../whmcs/normalize.js';

export type ProviderFamily = 'store' | 'billing';

export interface ConnectionTransport {
  /** Approved origin (scheme://host[:port]). */
  origin: string;
  /** Provider base URL. WooCommerce: the origin. WHMCS: the System URL (may carry a path). */
  baseUrl: string;
  installationId: string;
  secret: string;
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
  /** True when Web Yar keeps a catalogue index for it (initial sync + catalog_ready gate). */
  usesCatalogIndex: boolean;
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
    default:
      throw new Error(`no store connector registered for provider_type "${providerType}"`);
  }
}

export function resolveWhmcsConnector(transport: ConnectionTransport): WhmcsConnector {
  return new WhmcsConnector(transport);
}
