/**
 * SEO RANK TRACKING SERVICE
 *
 * The single consumption boundary for rank-check vendor calls in the
 * backend. Mirrors server/services/seo/backlinks/index.ts's shape exactly,
 * including the platform-level (not per-workspace) singleton config.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  RankTrackingError,
  RANK_TRACKING_PROVIDER_NAMES,
  SUPPORTED_RANK_TRACKING_PROVIDERS,
  type RankCheckResult,
  type RankTrackingProviderInfo,
  type RankTrackingProviderName,
  type RankTrackingTestResult,
  type DataForSeoRankTrackingConfig,
} from './types.js';
import { createDataForSeoRankTrackingAdapter, type DataForSeoRankTrackingAdapter, type DataForSeoRankTrackingAdapterOptions } from './providers/dataforseo.js';

const TABLE = 'platform_rank_tracking_provider_config';

export function isSupportedRankTrackingProvider(value: unknown): value is 'dataforseo' {
  return typeof value === 'string' && (SUPPORTED_RANK_TRACKING_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownRankTrackingProviderName(value: unknown): value is RankTrackingProviderName {
  return typeof value === 'string' && (RANK_TRACKING_PROVIDER_NAMES as readonly string[]).includes(value);
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
  if (error) throw new RankTrackingError('rank_tracking_provider_not_configured');
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

export async function getRankTrackingProviderInfo(serverConfig: ServerConfig): Promise<RankTrackingProviderInfo> {
  const row = await loadRow(serverConfig);
  if (!row) {
    return { providerName: 'disabled', configured: false, enabled: false, hasCredentials: false, login: null, updatedAt: null };
  }
  const providerName: RankTrackingProviderName = isKnownRankTrackingProviderName(row.provider_name) ? row.provider_name : 'disabled';
  const login = readString(row.config, 'login');
  const password = readString(row.config, 'password');
  return {
    providerName,
    configured: providerName !== 'disabled' && login !== null && password !== null,
    enabled: row.is_active && providerName !== 'disabled',
    hasCredentials: login !== null && password !== null,
    login,
    updatedAt: row.updated_at,
  };
}

export interface SaveRankTrackingProviderInput {
  providerName: string;
  enabled: boolean;
  login?: string;
  password?: string;
}

export type SaveRankTrackingProviderError = 'unsupported_provider' | 'login_required' | 'password_required' | 'save_failed';

export class RankTrackingConfigValidationError extends Error {
  readonly reason: SaveRankTrackingProviderError;
  constructor(reason: SaveRankTrackingProviderError) {
    super(reason);
    this.name = 'RankTrackingConfigValidationError';
    this.reason = reason;
  }
}

export async function saveRankTrackingProviderConfig(
  serverConfig: ServerConfig,
  input: SaveRankTrackingProviderInput,
  adminUserId: string,
): Promise<RankTrackingProviderInfo> {
  if (!isSupportedRankTrackingProvider(input.providerName)) {
    throw new RankTrackingConfigValidationError('unsupported_provider');
  }

  const existing = await loadRow(serverConfig);
  const sameProvider = existing?.provider_name === input.providerName;

  const incomingLogin = typeof input.login === 'string' ? input.login.trim() : '';
  const existingLogin = sameProvider ? readString(existing?.config ?? null, 'login') : null;
  const login = incomingLogin !== '' ? incomingLogin : existingLogin;
  if (!login) throw new RankTrackingConfigValidationError('login_required');

  const incomingPassword = typeof input.password === 'string' ? input.password.trim() : '';
  const existingPassword = sameProvider ? readString(existing?.config ?? null, 'password') : null;
  const password = incomingPassword !== '' ? incomingPassword : existingPassword;
  if (!password) throw new RankTrackingConfigValidationError('password_required');

  const nextConfig = { login, password };

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
  if (error) throw new RankTrackingConfigValidationError('save_failed');

  return getRankTrackingProviderInfo(serverConfig);
}

export async function deleteRankTrackingProviderConfig(serverConfig: ServerConfig, adminUserId: string): Promise<RankTrackingProviderInfo> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    { singleton: true, provider_name: 'disabled', config: {}, is_active: false, updated_by: adminUserId, updated_at: new Date().toISOString() },
    { onConflict: 'singleton' },
  );
  if (error) throw new RankTrackingConfigValidationError('save_failed');
  return getRankTrackingProviderInfo(serverConfig);
}

type ResolvedProvider = { providerName: 'dataforseo'; config: DataForSeoRankTrackingConfig; adapter: DataForSeoRankTrackingAdapter };

export interface RankTrackingRuntimeOptions {
  dataForSeoAdapterOptions?: DataForSeoRankTrackingAdapterOptions;
}

async function resolveProvider(serverConfig: ServerConfig, options: RankTrackingRuntimeOptions = {}): Promise<ResolvedProvider> {
  const row = await loadRow(serverConfig);
  if (!row || row.provider_name === 'disabled') {
    throw new RankTrackingError(row ? 'rank_tracking_provider_disabled' : 'rank_tracking_provider_not_configured');
  }
  if (!isSupportedRankTrackingProvider(row.provider_name)) throw new RankTrackingError('rank_tracking_provider_not_configured');
  if (!row.is_active) throw new RankTrackingError('rank_tracking_provider_disabled');

  const login = readString(row.config, 'login');
  const password = readString(row.config, 'password');
  if (!login || !password) throw new RankTrackingError('rank_tracking_provider_not_configured');

  const config: DataForSeoRankTrackingConfig = { provider: 'dataforseo', login, password };
  return { providerName: 'dataforseo', config, adapter: createDataForSeoRankTrackingAdapter(config, options.dataForSeoAdapterOptions) };
}

function toErrorCode(err: unknown) {
  return err instanceof RankTrackingError ? err.code : 'rank_tracking_provider_error';
}

export async function checkKeywordRank(
  serverConfig: ServerConfig,
  input: { keyword: string; targetHost: string; device: 'desktop' | 'mobile'; locationCode?: number | null },
  options: RankTrackingRuntimeOptions = {},
): Promise<{ provider: string; result: RankCheckResult }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.checkRank(input);
  return { provider: resolved.providerName, result };
}

export async function testRankTrackingProvider(serverConfig: ServerConfig, options: RankTrackingRuntimeOptions = {}): Promise<RankTrackingTestResult> {
  const startedAt = Date.now();
  let provider = 'unknown';
  try {
    const resolved = await resolveProvider(serverConfig, options);
    provider = resolved.providerName;
    const info = await resolved.adapter.getAccountInfo();
    return { success: true, provider, latencyMs: Date.now() - startedAt, balance: info.balance, currency: info.currency };
  } catch (err) {
    const errorCode = toErrorCode(err);
    return {
      success: false,
      provider,
      latencyMs: Date.now() - startedAt,
      errorCode,
      error: err instanceof RankTrackingError ? err.message : 'Rank tracking provider returned an error',
    };
  }
}
