/**
 * Connector registry — the ONE place that maps a connection's provider_type
 * to a concrete CommerceConnector implementation. Adding a provider means
 * adding one case here (and a profile in ../providers.ts); nothing above the
 * Commerce Gateway branches on provider type.
 */
import { CommerceError, type CommerceConnector } from '../../../../shared/commerce/types.js';
import { WooCommerceConnector, type WooCommerceTransport } from './woocommerce.js';
import { OpenCartConnector } from './opencart.js';

export interface ConnectorTransport extends WooCommerceTransport {
  /** Direct connectors: the store's base URL on the approved origin. */
  storeUrl?: string | null;
  externalStoreId?: string | null;
  platformVersion?: string | null;
}

export function resolveConnector(providerType: string, transport: ConnectorTransport): CommerceConnector {
  switch (providerType) {
    case 'woocommerce':
      return new WooCommerceConnector(transport);
    case 'opencart':
      if (!transport.storeUrl || transport.externalStoreId === null || transport.externalStoreId === undefined) {
        throw new CommerceError('commerce_not_connected', 'opencart connection has no store scope');
      }
      return new OpenCartConnector({
        origin: transport.origin,
        storeUrl: transport.storeUrl,
        externalStoreId: String(transport.externalStoreId),
        installationId: transport.installationId,
        secret: transport.secret,
        platformVersion: transport.platformVersion ?? null,
      });
    default:
      throw new Error(`no connector registered for provider_type "${providerType}"`);
  }
}
