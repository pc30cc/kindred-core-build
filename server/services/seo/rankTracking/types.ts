/**
 * SEO RANK TRACKING SERVICE — shared types and normalized error codes.
 * Mirrors server/services/seo/backlinks/types.ts's shape exactly.
 */

export const RANK_TRACKING_ERROR_CODES = [
  'rank_tracking_provider_not_configured',
  'rank_tracking_provider_disabled',
  'rank_tracking_auth_failed',
  'rank_tracking_insufficient_credit',
  'rank_tracking_invalid_input',
  'rank_tracking_rate_limited',
  'rank_tracking_timeout',
  'rank_tracking_network_error',
  'rank_tracking_provider_error',
] as const;

export type RankTrackingErrorCode = (typeof RANK_TRACKING_ERROR_CODES)[number];

export const RANK_TRACKING_ERROR_MESSAGES: Record<RankTrackingErrorCode, string> = {
  rank_tracking_provider_not_configured: 'Rank tracking provider is not configured',
  rank_tracking_provider_disabled: 'Rank tracking provider is disabled',
  rank_tracking_auth_failed: 'Authentication with the rank tracking provider failed',
  rank_tracking_insufficient_credit: 'Insufficient provider account credit',
  rank_tracking_invalid_input: 'Invalid rank check input',
  rank_tracking_rate_limited: 'Rank tracking provider rate limit exceeded',
  rank_tracking_timeout: 'Rank tracking provider request timed out',
  rank_tracking_network_error: 'Could not reach the rank tracking provider',
  rank_tracking_provider_error: 'Rank tracking provider returned an error',
};

export class RankTrackingError extends Error {
  readonly code: RankTrackingErrorCode;
  /** Optional provider-side explanation (status message). Never contains credentials. */
  readonly detail: string | null;
  constructor(code: RankTrackingErrorCode, detail?: string | null) {
    const base = RANK_TRACKING_ERROR_MESSAGES[code];
    super(detail ? `${base}: ${detail}` : base);
    this.name = 'RankTrackingError';
    this.code = code;
    this.detail = detail ?? null;
  }
}


export function isRankTrackingError(value: unknown): value is RankTrackingError {
  return value instanceof RankTrackingError;
}

export const SUPPORTED_RANK_TRACKING_PROVIDERS = ['dataforseo'] as const;
export type SupportedRankTrackingProvider = (typeof SUPPORTED_RANK_TRACKING_PROVIDERS)[number];

export const RANK_TRACKING_PROVIDER_NAMES = ['dataforseo', 'disabled'] as const;
export type RankTrackingProviderName = (typeof RANK_TRACKING_PROVIDER_NAMES)[number];

export interface DataForSeoRankTrackingConfig {
  provider: 'dataforseo';
  login: string;
  password: string;
}

export type RankTrackingProviderConfig = DataForSeoRankTrackingConfig;

export interface RankCheckResult {
  position: number | null;
  rankingUrl: string | null;
}

export interface RankTrackingProviderInfo {
  providerName: RankTrackingProviderName;
  configured: boolean;
  enabled: boolean;
  hasCredentials: boolean;
  login: string | null;
  updatedAt: string | null;
}

export interface RankTrackingAccountInfo {
  balance: number | null;
  currency: string;
}

export interface RankTrackingTestResult {
  success: boolean;
  provider: string;
  latencyMs: number;
  balance?: number | null;
  currency?: string;
  error?: string;
  errorCode?: RankTrackingErrorCode;
}
