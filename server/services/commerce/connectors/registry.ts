/**
 * Connector registry — the ONE place that maps a connection's provider_type
 * to a concrete CommerceConnector implementation. Adding a second provider
 * (Shopify, PrestaShop, ...) means adding one case here; nothing above the
 * Commerce Gateway ever branches on provider type again.
 */
import type { CommerceConnector } from '../../../../shared/commerce/types.js';
import { WooCommerceConnector, type WooCommerceTransport } from './woocommerce.js';

export function resolveConnector(providerType: string, transport: WooCommerceTransport): CommerceConnector {
  switch (providerType) {
    case 'woocommerce':
      return new WooCommerceConnector(transport);
    default:
      throw new Error(`no connector registered for provider_type "${providerType}"`);
  }
}
