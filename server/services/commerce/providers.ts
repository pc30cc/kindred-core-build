/**
 * Per-provider operating profile — the ONE place that says how a connector
 * type is run, so nothing else branches on provider names.
 *
 *   searchStrategy  'indexed' → Web Yar's own product index (sync + events),
 *                   gated on catalog_ready; 'direct' → live, bounded reads
 *                   from the store per question, no catalogue stored.
 *   catalogSync     whether sync jobs may ever be enqueued for it.
 *   periodicHealth  whether the commerce-sync worker's reconcile loop may run
 *                   a handshake against it. Direct connectors are never
 *                   polled: their health is what real requests observe, plus
 *                   the rate-limited manual check.
 *   guestOtp        whether the contact-match + OTP guest order path exists.
 */
import type { CommerceSearchStrategy } from '../../../shared/commerce/types.js';

export interface CommerceProviderProfile {
  searchStrategy: CommerceSearchStrategy;
  catalogSync: boolean;
  periodicHealth: boolean;
  guestOtp: boolean;
  /** Plugin registry id used for workspace_plugin_installations. */
  pluginId: string;
}

const PROFILES: Record<string, CommerceProviderProfile> = {
  woocommerce: { searchStrategy: 'indexed', catalogSync: true, periodicHealth: true, guestOtp: true, pluginId: 'woocommerce' },
  opencart: { searchStrategy: 'direct', catalogSync: false, periodicHealth: false, guestOtp: false, pluginId: 'opencart' },
};

export const COMMERCE_PROVIDERS = Object.keys(PROFILES);

export function providerProfile(providerType: string | null | undefined): CommerceProviderProfile {
  // Unknown providers get the most conservative profile: no background work.
  return PROFILES[String(providerType ?? '')] ?? { searchStrategy: 'indexed', catalogSync: false, periodicHealth: false, guestOtp: false, pluginId: String(providerType ?? '') };
}

export function isDirectProvider(providerType: string | null | undefined): boolean {
  return providerProfile(providerType).searchStrategy === 'direct';
}

/** Providers whose connections the background worker may touch. */
export function providersWithBackgroundWork(): string[] {
  return COMMERCE_PROVIDERS.filter((p) => PROFILES[p].catalogSync || PROFILES[p].periodicHealth);
}
