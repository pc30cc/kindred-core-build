/**
 * SEO KEYWORDS SERVICE — shared types and normalized error codes. Mirrors
 * server/services/seo/backlinks/types.ts's shape exactly.
 */

export const KEYWORDS_ERROR_CODES = [
  'keywords_provider_not_configured',
  'keywords_provider_disabled',
  'keywords_auth_failed',
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
  keywords_insufficient_credit: 'Insufficient provider account credit',
  keywords_invalid_input: 'Invalid keyword input',
  keywords_rate_limited: 'Keyword data provider rate limit exceeded',
  keywords_timeout: 'Keyword data provider request timed out',
  keywords_network_error: 'Could not reach the keyword data provider',
  keywords_provider_error: 'Keyword data provider returned an error',
};

export class KeywordsError extends Error {
  readonly code: KeywordsErrorCode;
  constructor(code: KeywordsErrorCode) {
    super(KEYWORDS_ERROR_MESSAGES[code]);
    this.name = 'KeywordsError';
    this.code = code;
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
