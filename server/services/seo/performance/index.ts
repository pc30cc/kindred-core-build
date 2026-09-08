/**
 * SEO PERFORMANCE SERVICE
 *
 * The single consumption boundary for performance-data vendor calls in the
 * backend. Mirrors server/services/seo/backlinks/index.ts's shape, adapted
 * for a single optional `apiKey` credential instead of login+password.
 *
 * Storage: `public.platform_performance_provider_config` — a service-role-only
 * table. The key lives there and is read ONLY by this module through the
 * service client. It is never returned to the browser and never logged.
 *
 * Resolution (this phase): the single active platform-level config.
 * Workspace overrides are intentionally NOT consulted: which vendor answers
 * "how fast does this page load" is a platform operations decision, not a
 * per-workspace setting — usage is instead bounded per workspace by
 * server/services/seo/performanceLimits.ts. The adapter registry below is
 * the extension point for future vendors (WebPageTest, GTmetrix, ...).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  PerformanceError,
  PERFORMANCE_PROVIDER_NAMES,
  SUPPORTED_PERFORMANCE_PROVIDERS,
  type PerformanceAuditItem,
  type PerformanceProviderInfo,
  type PerformanceProviderName,
  type PerformanceStrategy,
  type PerformanceTestResult,
  type PageSpeedConfig,
} from './types.js';
import { createPageSpeedAdapter, type PageSpeedAdapter, type PageSpeedAdapterOptions } from './providers/pagespeed.js';

const TABLE = 'platform_performance_provider_config';
/** Lightweight, always-reachable target used only to validate connectivity/credentials. */
const TEST_TARGET_URL = 'https://www.example.com/';

export function isSupportedPerformanceProvider(value: unknown): value is 'pagespeed' {
  return typeof value === 'string' && (SUPPORTED_PERFORMANCE_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownPerformanceProviderName(value: unknown): value is PerformanceProviderName {
  return typeof value === 'string' && (PERFORMANCE_PROVIDER_NAMES as readonly string[]).includes(value);
}

interface StoredRow {
  provider_name: string;
  config: Record<string, unknown> | null;
  is_active: boolean;
  updated_at: string | null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value: unknown = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function loadRow(serverConfig: ServerConfig): Promise<StoredRow | null> {
  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb
    .from(TABLE)
    .select('provider_name, config, is_active, updated_at')
    .eq('singleton', true)
    .maybeSingle();
  if (error) throw new PerformanceError('performance_provider_not_configured');
  if (!data) return null;
  return {
    provider_name: typeof data.provider_name === 'string' ? data.provider_name : 'disabled',
    config:
      data.config && typeof data.config === 'object' && !Array.isArray(data.config)
        ? (data.config as Record<string, unknown>)
        : null,
    is_active: data.is_active === true,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
  };
}

/** Redacted status for the admin UI. Never includes the credential. */
export async function getPerformanceProviderInfo(serverConfig: ServerConfig): Promise<PerformanceProviderInfo> {
  const row = await loadRow(serverConfig);
  if (!row) {
    return { providerName: 'disabled', configured: false, enabled: false, hasCredentials: false, updatedAt: null };
  }
  const providerName: PerformanceProviderName = isKnownPerformanceProviderName(row.provider_name) ? row.provider_name : 'disabled';
  const apiKey = readString(row.config, 'apiKey');
  return {
    providerName,
    // PSI works keyless, so "configured" only requires the provider to be selected, not a key.
    configured: providerName !== 'disabled',
    enabled: row.is_active && providerName !== 'disabled',
    hasCredentials: apiKey !== null,
    updatedAt: row.updated_at,
  };
}

export interface SavePerformanceProviderInput {
  providerName: string;
  enabled: boolean;
  /** Omitted / blank on update = keep the stored key (or none). */
  apiKey?: string;
}

export type SavePerformanceProviderError = 'unsupported_provider' | 'save_failed';

export class PerformanceConfigValidationError extends Error {
  readonly reason: SavePerformanceProviderError;
  constructor(reason: SavePerformanceProviderError) {
    super(reason);
    this.name = 'PerformanceConfigValidationError';
    this.reason = reason;
  }
}

/** Persist the platform performance-provider config. Only whitelisted keys are stored. */
export async function savePerformanceProviderConfig(
  serverConfig: ServerConfig,
  input: SavePerformanceProviderInput,
  adminUserId: string,
): Promise<PerformanceProviderInfo> {
  if (!isSupportedPerformanceProvider(input.providerName)) {
    throw new PerformanceConfigValidationError('unsupported_provider');
  }

  const existing = await loadRow(serverConfig);
  const sameProvider = existing?.provider_name === input.providerName;

  const incomingKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const existingKey = sameProvider ? readString(existing?.config ?? null, 'apiKey') : null;
  const apiKey = incomingKey !== '' ? incomingKey : existingKey;

  const nextConfig = { apiKey: apiKey ?? null };

  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    {
      singleton: true,
      provider_name: input.providerName,
      config: nextConfig,
      is_active: input.enabled === true,
      updated_by: adminUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton' },
  );
  if (error) throw new PerformanceConfigValidationError('save_failed');

  return getPerformanceProviderInfo(serverConfig);
}

/** Disable and wipe the stored credential. */
export async function deletePerformanceProviderConfig(serverConfig: ServerConfig, adminUserId: string): Promise<PerformanceProviderInfo> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    { singleton: true, provider_name: 'disabled', config: {}, is_active: false, updated_by: adminUserId, updated_at: new Date().toISOString() },
    { onConflict: 'singleton' },
  );
  if (error) throw new PerformanceConfigValidationError('save_failed');
  return getPerformanceProviderInfo(serverConfig);
}

type ResolvedProvider = { providerName: 'pagespeed'; config: PageSpeedConfig; adapter: PageSpeedAdapter };

export interface PerformanceRuntimeOptions {
  /** Test seam forwarded to the PageSpeed adapter. */
  pageSpeedAdapterOptions?: PageSpeedAdapterOptions;
}

/** Resolve the active provider. Fail-closed at every gap: missing row, disabled flag, unsupported vendor. */
async function resolveProvider(serverConfig: ServerConfig, options: PerformanceRuntimeOptions = {}): Promise<ResolvedProvider> {
  const row = await loadRow(serverConfig);
  if (!row || row.provider_name === 'disabled') {
    throw new PerformanceError(row ? 'performance_provider_disabled' : 'performance_provider_not_configured');
  }
  if (!isSupportedPerformanceProvider(row.provider_name)) throw new PerformanceError('performance_provider_not_configured');
  if (!row.is_active) throw new PerformanceError('performance_provider_disabled');

  const apiKey = readString(row.config, 'apiKey');
  const config: PageSpeedConfig = { provider: 'pagespeed', apiKey };
  return { providerName: 'pagespeed', config, adapter: createPageSpeedAdapter(config, options.pageSpeedAdapterOptions) };
}

function toErrorCode(err: unknown) {
  return err instanceof PerformanceError ? err.code : 'performance_provider_error';
}

/** Audit a single URL. Internal service API — no public route calls the vendor directly. */
export async function auditUrlPerformance(
  serverConfig: ServerConfig,
  url: string,
  strategy: PerformanceStrategy,
  options: PerformanceRuntimeOptions = {},
): Promise<{ provider: string; result: PerformanceAuditItem }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.auditUrl({ url, strategy });
  return { provider: resolved.providerName, result };
}

/** Admin connection test. Runs one real, lightweight audit against a fixed test URL. */
export async function testPerformanceProvider(serverConfig: ServerConfig, options: PerformanceRuntimeOptions = {}): Promise<PerformanceTestResult> {
  const startedAt = Date.now();
  let provider = 'unknown';
  try {
    const resolved = await resolveProvider(serverConfig, options);
    provider = resolved.providerName;
    await resolved.adapter.auditUrl({ url: TEST_TARGET_URL, strategy: 'mobile' });
    return { success: true, provider, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const errorCode = toErrorCode(err);
    return {
      success: false,
      provider,
      latencyMs: Date.now() - startedAt,
      errorCode,
      error: err instanceof PerformanceError ? err.message : 'Performance data provider returned an error',
    };
  }
}
