/**
 * SEO GSC INSIGHTS SERVICE — shared types and normalized error codes.
 *
 * Mirrors server/services/seo/performance/types.ts's shape: this module is
 * the ONLY consumption boundary for Google Search Console calls in the
 * backend. Vendor SDK/HTTP errors never escape past this layer.
 *
 * Unlike the other four SEO modules there is no platform-level vendor
 * credential — each workspace authorizes its OWN Google account via OAuth
 * 2.0 (see oauth.ts), so the error surface here also covers the connection
 * lifecycle (not-connected, token expired/revoked), not just the data API.
 */

export const GSC_ERROR_CODES = [
  'gsc_not_configured',
  'gsc_not_connected',
  'gsc_no_property_linked',
  'gsc_property_not_found',
  'gsc_invalid_state',
  'gsc_auth_failed',
  'gsc_token_revoked',
  'gsc_rate_limited',
  'gsc_timeout',
  'gsc_network_error',
  'gsc_provider_error',
  'gsc_limit_reached',
] as const;

export type GscErrorCode = (typeof GSC_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const GSC_ERROR_MESSAGES: Record<GscErrorCode, string> = {
  gsc_not_configured: 'Google Search Console integration is not configured on this platform',
  gsc_not_connected: 'No Google Search Console account is connected for this workspace',
  gsc_no_property_linked: 'No Search Console property is linked yet',
  gsc_property_not_found: 'Search Console property not found for this workspace',
  gsc_invalid_state: 'The Google sign-in link expired or was already used — please try connecting again',
  gsc_auth_failed: 'Authentication with Google Search Console failed',
  gsc_token_revoked: 'Access to this Google account was revoked — please reconnect',
  gsc_rate_limited: 'Google Search Console rate limit exceeded',
  gsc_timeout: 'Google Search Console request timed out',
  gsc_network_error: 'Could not reach Google Search Console',
  gsc_provider_error: 'Google Search Console returned an error',
  gsc_limit_reached: 'Maximum number of connected Search Console properties reached for your plan',
};

export class GscError extends Error {
  readonly code: GscErrorCode;
  /**
   * Human-readable, credential-free explanation of what actually failed
   * (e.g. Google's own 403 message). Surfaced to admins so a generic
   * "authentication failed" toast is never the only signal.
   */
  readonly detail?: string;
  constructor(code: GscErrorCode, message?: string, detail?: string) {
    super(message || GSC_ERROR_MESSAGES[code]);
    this.name = 'GscError';
    this.code = code;
    this.detail = detail;
  }
}


export function isGscError(value: unknown): value is GscError {
  return value instanceof GscError;
}

export interface GscConnectionInfo {
  connected: boolean;
  googleAccountEmail: string | null;
  status: 'active' | 'revoked' | 'error' | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface GscPropertyInfo {
  id: string;
  siteUrl: string;
  permissionLevel: string | null;
  isPrimary: boolean;
  websiteId: string | null;
  createdAt: string;
}

export type GscDimension = 'query' | 'page' | 'device' | 'country' | 'date' | 'searchAppearance';

export interface GscSearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  rowLimit?: number;
  startRow?: number;
}

export interface GscSearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSearchAnalyticsResult {
  rows: GscSearchAnalyticsRow[];
  responseAggregationType: string | null;
  cached: boolean;
  fetchedAt: string;
}
