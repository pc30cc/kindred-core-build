/**
 * Per-provider operating profile: how a connector type is RUN. Derived from
 * the connector registry (connectors/registry.ts), which stays the one place
 * that describes a provider, so nothing else branches on provider names.
 *
 *   searchStrategy  'indexed' → Web Yar's own product index (sync + events),
 *                   gated on catalog_ready; 'direct' → live, bounded reads
 *                   from the store per question, no catalogue stored. Only
 *                   meaningful for the `store` family (a billing provider
 *                   such as WHMCS has its own stage and is neither).
 *   catalogSync     whether sync jobs may ever be enqueued for it.
 *   periodicHealth  whether the commerce-sync worker's reconcile loop may run
 *                   a handshake against it. Direct connectors are never
 *                   polled: their health is what real requests observe, plus
 *                   the rate-limited manual check.
 *   guestOtp        whether the contact-match + OTP guest order path exists.
 */
import type { CommerceSearchStrategy } from '../../../shared/commerce/types.js';
import { catalogIndexedProviders, getProviderDescriptor } from './connectors/registry.js';

export interface CommerceProviderProfile {
  searchStrategy: CommerceSearchStrategy;
  catalogSync: boolean;
  periodicHealth: boolean;
  guestOtp: boolean;
  /** Plugin registry id used for workspace_plugin_installations. */
  pluginId: string;
}

export function providerProfile(providerType: string | null | undefined): CommerceProviderProfile {
  const d = getProviderDescriptor(String(providerType ?? ''));
  // Unknown providers get the most conservative profile: no background work.
  if (!d) return { searchStrategy: 'indexed', catalogSync: false, periodicHealth: false, guestOtp: false, pluginId: String(providerType ?? '') };
  return {
    searchStrategy: d.family === 'store' && !d.usesCatalogIndex ? 'direct' : 'indexed',
    catalogSync: d.usesCatalogIndex,
    periodicHealth: d.usesCatalogIndex,
    guestOtp: d.guestOtp,
    pluginId: d.pluginId,
  };
}

/** A store read live per question, with no index (OpenCart). */
export function isDirectProvider(providerType: string | null | undefined): boolean {
  return providerProfile(providerType).searchStrategy === 'direct';
}

/** Providers whose connections the background worker may touch. */
export function providersWithBackgroundWork(): string[] {
  return catalogIndexedProviders();
}
