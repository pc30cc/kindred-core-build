/**
 * SEO PERFORMANCE SERVICE — shared types and normalized error codes.
 *
 * Mirrors server/services/seo/backlinks/types.ts's shape: this module is
 * the ONLY consumption boundary for performance-data vendor calls in the
 * backend. Vendor SDK/HTTP errors never escape past this layer.
 *
 * Unlike Backlinks/Keywords (HTTP Basic login+password), Google's
 * PageSpeed Insights API authenticates with a single bearer-style API key
 * (and works keyless at a much lower, shared quota) — so the stored config
 * shape here is `{ apiKey }`, not `{ login, password }`.
 */

export const PERFORMANCE_ERROR_CODES = [
  'performance_provider_not_configured',
  'performance_provider_disabled',
  'performance_auth_failed',
  'performance_invalid_target',
  'performance_rate_limited',
  'performance_timeout',
  'performance_network_error',
  'performance_provider_error',
] as const;

export type PerformanceErrorCode = (typeof PERFORMANCE_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const PERFORMANCE_ERROR_MESSAGES: Record<PerformanceErrorCode, string> = {
  performance_provider_not_configured: 'Performance data provider is not configured',
  performance_provider_disabled: 'Performance data provider is disabled',
  performance_auth_failed: 'Authentication with the performance data provider failed',
  performance_invalid_target: 'Invalid target URL',
  performance_rate_limited: 'Performance data provider rate limit exceeded',
  performance_timeout: 'Performance data provider request timed out',
  performance_network_error: 'Could not reach the performance data provider',
  performance_provider_error: 'Performance data provider returned an error',
};

export class PerformanceError extends Error {
  readonly code: PerformanceErrorCode;
  constructor(code: PerformanceErrorCode) {
    super(PERFORMANCE_ERROR_MESSAGES[code]);
    this.name = 'PerformanceError';
    this.code = code;
  }
}

export function isPerformanceError(value: unknown): value is PerformanceError {
  return value instanceof PerformanceError;
}

/** Vendors that have a real runtime adapter in this phase. */
export const SUPPORTED_PERFORMANCE_PROVIDERS = ['pagespeed'] as const;
export type SupportedPerformanceProvider = (typeof SUPPORTED_PERFORMANCE_PROVIDERS)[number];

/** Values accepted by the `provider_name` column. */
export const PERFORMANCE_PROVIDER_NAMES = ['pagespeed', 'disabled'] as const;
export type PerformanceProviderName = (typeof PERFORMANCE_PROVIDER_NAMES)[number];

export interface PageSpeedConfig {
  provider: 'pagespeed';
  /** Google API key. Optional — PSI works keyless at a lower shared quota. */
  apiKey: string | null;
}

/** Discriminated union of every runtime performance-provider configuration. Only one member today — kept a union so a second vendor never touches call sites, only adds a branch here and in resolveProvider(). */
export type PerformanceProviderConfig = PageSpeedConfig;

export type PerformanceStrategy = 'mobile' | 'desktop';

export interface PerformanceAuditItem {
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  tbtMs: number | null;
  rawSummary: Record<string, unknown>;
}

/** Redacted view of the stored config. NEVER carries the credential. */
export interface PerformanceProviderInfo {
  providerName: PerformanceProviderName;
  configured: boolean;
  enabled: boolean;
  hasCredentials: boolean;
  updatedAt: string | null;
}

export interface PerformanceTestResult {
  success: boolean;
  provider: string;
  latencyMs: number;
  error?: string;
  errorCode?: PerformanceErrorCode;
}
