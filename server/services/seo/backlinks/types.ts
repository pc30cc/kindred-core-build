/**
 * SEO BACKLINKS SERVICE — shared types and normalized error codes.
 *
 * Mirrors server/services/sms/types.ts's shape exactly: this module is the
 * ONLY consumption boundary for backlink-data vendor calls in the backend.
 * Vendor SDK/HTTP errors never escape past this layer: they are mapped to
 * the closed union of `BacklinksErrorCode` below so no raw vendor payload,
 * stack trace or credential can reach an HTTP response or a log line.
 */

export const BACKLINKS_ERROR_CODES = [
  'backlinks_provider_not_configured',
  'backlinks_provider_disabled',
  'backlinks_auth_failed',
  'backlinks_account_unverified',
  'backlinks_subscription_required',
  'backlinks_ip_not_allowed',
  'backlinks_insufficient_credit',
  'backlinks_invalid_target',
  'backlinks_rate_limited',
  'backlinks_timeout',
  'backlinks_network_error',
  'backlinks_provider_error',
] as const;

export type BacklinksErrorCode = (typeof BACKLINKS_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const BACKLINKS_ERROR_MESSAGES: Record<BacklinksErrorCode, string> = {
  backlinks_provider_not_configured: 'Backlinks data provider is not configured',
  backlinks_provider_disabled: 'Backlinks data provider is disabled',
  backlinks_auth_failed: 'Authentication with the backlinks data provider failed',
  backlinks_account_unverified: 'The DataForSEO account is not verified yet — complete verification in app.dataforseo.com, then retry',
  backlinks_subscription_required: 'Backlinks API access is not enabled for this DataForSEO account',
  backlinks_ip_not_allowed: 'The SEO worker IP address is not allowed by DataForSEO',
  backlinks_insufficient_credit: 'Insufficient provider account credit',
  backlinks_invalid_target: 'Invalid target URL',
  backlinks_rate_limited: 'Backlinks data provider rate limit exceeded',
  backlinks_timeout: 'Backlinks data provider request timed out',
  backlinks_network_error: 'Could not reach the backlinks data provider',
  backlinks_provider_error: 'Backlinks data provider returned an error',
};

export class BacklinksError extends Error {
  readonly code: BacklinksErrorCode;
  /** Optional provider-side explanation (status message). Never contains credentials. */
  readonly detail: string | null;
  constructor(code: BacklinksErrorCode, detail?: string | null) {
    const base = BACKLINKS_ERROR_MESSAGES[code];
    super(detail ? `${base}: ${detail}` : base);
    this.name = 'BacklinksError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function isBacklinksError(value: unknown): value is BacklinksError {
  return value instanceof BacklinksError;
}

/** Vendors that have a real runtime adapter in this phase. */
export const SUPPORTED_BACKLINKS_PROVIDERS = ['dataforseo'] as const;
export type SupportedBacklinksProvider = (typeof SUPPORTED_BACKLINKS_PROVIDERS)[number];

/** Values accepted by the `provider_name` column. */
export const BACKLINKS_PROVIDER_NAMES = ['dataforseo', 'disabled'] as const;
export type BacklinksProviderName = (typeof BACKLINKS_PROVIDER_NAMES)[number];

export interface DataForSeoBacklinksConfig {
  provider: 'dataforseo';
  /** DataForSEO account login (HTTP Basic auth username). */
  login: string;
  /** DataForSEO account password (HTTP Basic auth password). */
  password: string;
}

/** Discriminated union of every runtime backlinks-provider configuration. Only one member today — kept a union so a second vendor never touches call sites, only adds a branch here and in resolveProvider(). */
export type BacklinksProviderConfig = DataForSeoBacklinksConfig;

export interface BacklinkResultItem {
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchorText: string | null;
  isDofollow: boolean;
  isNew: boolean;
  isLost: boolean;
  pageRank: number | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface BacklinksFetchResult {
  items: BacklinkResultItem[];
  totalCount: number;
  referringDomains: number;
  dofollowCount: number;
  nofollowCount: number;
  newCount: number;
  lostCount: number;
}

/** Redacted view of the stored config. NEVER carries the credential. */
export interface BacklinksProviderInfo {
  providerName: BacklinksProviderName;
  configured: boolean;
  enabled: boolean;
  hasCredentials: boolean;
  login: string | null;
  updatedAt: string | null;
}

export interface BacklinksAccountInfo {
  balance: number | null;
  currency: string;
}

export interface BacklinksTestResult {
  success: boolean;
  provider: string;
  latencyMs: number;
  balance?: number | null;
  currency?: string;
  error?: string;
  errorCode?: BacklinksErrorCode;
}
