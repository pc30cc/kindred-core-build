/**
 * Widget-bridge provider ids: what the browser sees vs. what is stored.
 *
 * The platform's own chat widget is the provider `platform` in every API
 * response (shared/widgetBridge.ts), in both editions, so no client build
 * ever needs the Iran brand's name. The bridge database, the worker and older
 * clients keep the original id (`LEGACY_PLATFORM_PROVIDER`): requests carrying
 * either id are accepted and stored as before (no data migration), and every
 * response maps the stored id back to `platform`.
 *
 * Server and worker only: never imported by the client.
 */
import type { BridgeAllowedProvider, BridgeProvider, BridgeSiteLists } from '../../../shared/widgetBridge.js';

/** The id stored in widget_bridge_* rows (and sent by clients from before `platform`). */
export const LEGACY_PLATFORM_PROVIDER = 'webyar' as const;

/** Stored provider ids, in the API's order. */
export const storedBridgeProviders = [LEGACY_PLATFORM_PROVIDER, 'crisp', 'raychat', 'goftino', 'custom'] as const;
export type StoredBridgeAllowedProvider = typeof storedBridgeProviders[number];
export type StoredBridgeProvider = 'auto' | StoredBridgeAllowedProvider;

/** Every id a request may carry for an allowed provider: the API's and the legacy one. */
export const acceptedBridgeProviders = ['platform', ...storedBridgeProviders] as const;
export type AcceptedBridgeAllowedProvider = typeof acceptedBridgeProviders[number];

/** An id from a request (API or legacy) as stored. */
export function toStoredProvider(id: AcceptedBridgeAllowedProvider): StoredBridgeAllowedProvider;
export function toStoredProvider(id: 'auto' | AcceptedBridgeAllowedProvider): StoredBridgeProvider;
export function toStoredProvider(id: string): string;
export function toStoredProvider(id: string): string {
  return id === 'platform' ? LEGACY_PLATFORM_PROVIDER : id;
}

/** A stored id as the API returns it. */
export function toApiProvider(id: StoredBridgeAllowedProvider): BridgeAllowedProvider;
export function toApiProvider(id: StoredBridgeProvider): BridgeProvider;
export function toApiProvider<T>(id: T): T;
export function toApiProvider(id: unknown): unknown {
  return id === LEGACY_PLATFORM_PROVIDER ? 'platform' : id;
}

/** A stored list of allowed providers as stored, without duplicates (a request may name both ids). */
export function toStoredProviderList(ids: readonly AcceptedBridgeAllowedProvider[]): StoredBridgeAllowedProvider[] {
  return [...new Set(ids.map(id => toStoredProvider(id)))];
}

/** A row or settings object with its provider fields mapped for the API. */
export function apiBridgeSettings<T extends { allowedProviders?: unknown }>(settings: T): T {
  if (!Array.isArray(settings.allowedProviders)) return settings;
  return { ...settings, allowedProviders: settings.allowedProviders.map(id => toApiProvider(id)) };
}

export function apiBridgeContact<T extends { provider?: unknown }>(contact: T): T {
  return 'provider' in contact ? { ...contact, provider: toApiProvider(contact.provider) } : contact;
}

/** Stored site lists (keyed by stored provider id) keyed by API id. */
export function apiBridgeSiteLists(lists: Record<string, unknown> | null | undefined): BridgeSiteLists {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lists || {})) result[toApiProvider(key) as string] = value;
  return result as BridgeSiteLists;
}
