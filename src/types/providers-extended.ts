// ============================================
// EXTENDED PROVIDER INTERFACES
// Billing, Captcha, CDN — not in the original providers.ts
// ============================================

import type { MutationResult } from './providers';

// --- Billing Provider ---
export interface BillingPlan {
  id: string;
  name: string;
  slug: string;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  features: Record<string, boolean | number | string>;
  limits: Record<string, number>;
}

export interface BillingSubscription {
  id: string;
  planId: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export interface BillingProvider {
  getPlans(): Promise<MutationResult<BillingPlan[]>>;
  getSubscription(workspaceId: string): Promise<MutationResult<BillingSubscription | null>>;
  createCheckoutSession(workspaceId: string, planId: string, interval: 'monthly' | 'yearly'): Promise<MutationResult<{ url: string }>>;
  createPortalSession(workspaceId: string): Promise<MutationResult<{ url: string }>>;
  cancelSubscription(workspaceId: string): Promise<MutationResult<null>>;
  isFeatureAvailable(workspaceId: string, feature: string): Promise<boolean>;
  getUsage(workspaceId: string): Promise<MutationResult<Record<string, { used: number; limit: number }>>>;
}

// --- Captcha / Abuse Protection Provider ---
export interface CaptchaVerifyResult {
  success: boolean;
  score?: number; // 0-1 for invisible captcha
  errorCodes?: string[];
}

export interface CaptchaProvider {
  getSiteKey(): string;
  getScriptUrl(): string;
  verify(token: string, remoteIp?: string): Promise<CaptchaVerifyResult>;
  isEnabled(): boolean;
}

// --- CDN / Asset Provider ---
export interface CDNProvider {
  getBaseUrl(): string;
  purge(paths: string[]): Promise<MutationResult<null>>;
  getAssetUrl(path: string, transforms?: Record<string, string | number>): string;
  upload(path: string, data: Blob | ArrayBuffer): Promise<MutationResult<{ url: string }>>;
}

// --- Geo Enrichment Provider ---
// Resolves an IP address (or ip_hash) to country/city/coords.
// Implementations live server-side; the frontend interface exists for
// schema/registry parity with other provider types.
export interface GeoEnrichmentResult {
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  source: 'cache' | 'provider' | 'centroid' | 'session' | 'none';
}

export interface GeoEnrichmentProvider {
  /** Resolve geo info for a given IP. May return null when provider has no data. */
  lookup(ip: string): Promise<GeoEnrichmentResult | null>;
  /** Whether the provider is operational / configured. */
  isEnabled(): boolean;
}

// --- Map Tiles Provider ---
// Describes the tile source the frontend map canvas should use.
export interface MapTilesConfigShape {
  enabled: boolean;
  provider: string;
  tileUrl: string | null;
  attribution: string;
  maxZoom: number;
  minZoom: number;
}

export interface MapTilesProvider {
  getConfig(): MapTilesConfigShape;
  isEnabled(): boolean;
}
