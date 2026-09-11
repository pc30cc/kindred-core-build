/**
 * SEO KEYWORDS SERVICE — shared types and normalized error codes. Mirrors
 * server/services/seo/backlinks/types.ts's shape exactly.
 */

export const KEYWORDS_ERROR_CODES = [
  'keywords_provider_not_configured',
  'keywords_provider_disabled',
  'keywords_auth_failed',
  'keywords_account_unverified',
  'keywords_subscription_required',
  'keywords_ip_not_allowed',
  'keywords_insufficient_credit',
  'keywords_invalid_input',
  'keywords_rate_limited',
  'keywords_timeout',
  'keywords_network_error',
  'keywords_provider_error',
] as const;

export type KeywordsErrorCode = (typeof KEYWORDS_ERROR_CODES)[number];

export const KEYWORDS_ERROR_MESSAGES: Record<KeywordsErrorCode, string> = {
  keywords_provider_not_configured: 'Keyword data provider is not configured',
  keywords_provider_disabled: 'Keyword data provider is disabled',
  keywords_auth_failed: 'Authentication with the keyword data provider failed',
  keywords_account_unverified: 'The DataForSEO account is not verified yet — complete verification in app.dataforseo.com, then retry',
  keywords_subscription_required: 'The DataForSEO account has no active subscription for this keyword API',
  keywords_ip_not_allowed: 'This server IP is not allowed by the DataForSEO account IP whitelist',
  keywords_insufficient_credit: 'Insufficient provider account credit',
  keywords_invalid_input: 'Invalid keyword input',
  keywords_rate_limited: 'Keyword data provider rate limit exceeded',
  keywords_timeout: 'Keyword data provider request timed out',
  keywords_network_error: 'Could not reach the keyword data provider',
  keywords_provider_error: 'Keyword data provider returned an error',
};

export class KeywordsError extends Error {
  readonly code: KeywordsErrorCode;
  /** Optional provider-side explanation (status message). Never contains credentials. */
  readonly detail: string | null;
  constructor(code: KeywordsErrorCode, detail?: string | null) {
    const base = KEYWORDS_ERROR_MESSAGES[code];
    super(detail ? `${base}: ${detail}` : base);
    this.name = 'KeywordsError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function isKeywordsError(value: unknown): value is KeywordsError {
  return value instanceof KeywordsError;
}

export const SUPPORTED_KEYWORDS_PROVIDERS = ['dataforseo'] as const;
export type SupportedKeywordsProvider = (typeof SUPPORTED_KEYWORDS_PROVIDERS)[number];

export const KEYWORDS_PROVIDER_NAMES = ['dataforseo', 'disabled'] as const;
export type KeywordsProviderName = (typeof KEYWORDS_PROVIDER_NAMES)[number];

export interface DataForSeoKeywordsConfig {
  provider: 'dataforseo';
  login: string;
  password: string;
}

export type KeywordsProviderConfig = DataForSeoKeywordsConfig;

export interface KeywordResultItem {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel: 'low' | 'medium' | 'high' | null;
}

export interface KeywordsFetchResult {
  items: KeywordResultItem[];
}

/**
 * One row of DataForSEO Labs' Ranked Keywords report: a keyword the TARGET
 * DOMAIN currently ranks for — distinct from KeywordResultItem, which is a
 * seed-keyword volume lookup with no ranking/URL/traffic data at all.
 */
export interface RankedKeywordItem {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  /** The target domain's current absolute SERP position for this keyword. */
  position: number | null;
  /** The target domain's URL ranking for this keyword. */
  rankingUrl: string | null;
  /** Estimated monthly organic clicks this keyword drives to the ranking URL. */
  trafficEstimate: number | null;
}

export interface RankedKeywordsFetchResult {
  items: RankedKeywordItem[];
  totalCount: number;
}

export interface KeywordsProviderInfo {
  providerName: KeywordsProviderName;
  configured: boolean;
  enabled: boolean;
  hasCredentials: boolean;
  login: string | null;
  updatedAt: string | null;
}

export interface KeywordsAccountInfo {
  balance: number | null;
  currency: string;
}

export interface KeywordsTestResult {
  success: boolean;
  provider: string;
  latencyMs: number;
  balance?: number | null;
  currency?: string;
  error?: string;
  errorCode?: KeywordsErrorCode;
}
