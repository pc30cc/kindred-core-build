/**
 * SEO KEYWORDS SERVICE
 *
 * The single consumption boundary for keyword-data vendor calls in the
 * backend. Mirrors server/services/seo/backlinks/index.ts's shape exactly,
 * including the platform-level (not per-workspace) singleton config.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  KeywordsError,
  KEYWORDS_PROVIDER_NAMES,
  SUPPORTED_KEYWORDS_PROVIDERS,
  type KeywordsFetchResult,
  type KeywordsProviderInfo,
  type KeywordsProviderName,
  type KeywordsTestResult,
  type DataForSeoKeywordsConfig,
  type RankedKeywordsFetchResult,
  type CompetingDomainsFetchResult,
} from './types.js';
import { createDataForSeoKeywordsAdapter, type DataForSeoKeywordsAdapter, type DataForSeoKeywordsAdapterOptions } from './providers/dataforseo.js';

const TABLE = 'platform_keywords_provider_config';

export function isSupportedKeywordsProvider(value: unknown): value is 'dataforseo' {
  return typeof value === 'string' && (SUPPORTED_KEYWORDS_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownKeywordsProviderName(value: unknown): value is KeywordsProviderName {
  return typeof value === 'string' && (KEYWORDS_PROVIDER_NAMES as readonly string[]).includes(value);
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
  if (error) throw new KeywordsError('keywords_provider_not_configured');
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

export async function getKeywordsProviderInfo(serverConfig: ServerConfig): Promise<KeywordsProviderInfo> {
  const row = await loadRow(serverConfig);
  if (!row) {
    return { providerName: 'disabled', configured: false, enabled: false, hasCredentials: false, login: null, updatedAt: null };
  }
  const providerName: KeywordsProviderName = isKnownKeywordsProviderName(row.provider_name) ? row.provider_name : 'disabled';
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

export interface SaveKeywordsProviderInput {
  providerName: string;
  enabled: boolean;
  login?: string;
  password?: string;
}

export type SaveKeywordsProviderError = 'unsupported_provider' | 'login_required' | 'password_required' | 'save_failed';

export class KeywordsConfigValidationError extends Error {
  readonly reason: SaveKeywordsProviderError;
  constructor(reason: SaveKeywordsProviderError) {
    super(reason);
    this.name = 'KeywordsConfigValidationError';
    this.reason = reason;
  }
}

export async function saveKeywordsProviderConfig(
  serverConfig: ServerConfig,
  input: SaveKeywordsProviderInput,
  adminUserId: string,
): Promise<KeywordsProviderInfo> {
  if (!isSupportedKeywordsProvider(input.providerName)) {
    throw new KeywordsConfigValidationError('unsupported_provider');
  }

  const existing = await loadRow(serverConfig);
  const sameProvider = existing?.provider_name === input.providerName;

  const incomingLogin = typeof input.login === 'string' ? input.login.trim() : '';
  const existingLogin = sameProvider ? readString(existing?.config ?? null, 'login') : null;
  const login = incomingLogin !== '' ? incomingLogin : existingLogin;
  if (!login) throw new KeywordsConfigValidationError('login_required');

  const incomingPassword = typeof input.password === 'string' ? input.password.trim() : '';
  const existingPassword = sameProvider ? readString(existing?.config ?? null, 'password') : null;
  const password = incomingPassword !== '' ? incomingPassword : existingPassword;
  if (!password) throw new KeywordsConfigValidationError('password_required');

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
  if (error) throw new KeywordsConfigValidationError('save_failed');

  return getKeywordsProviderInfo(serverConfig);
}

export async function deleteKeywordsProviderConfig(serverConfig: ServerConfig, adminUserId: string): Promise<KeywordsProviderInfo> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    { singleton: true, provider_name: 'disabled', config: {}, is_active: false, updated_by: adminUserId, updated_at: new Date().toISOString() },
    { onConflict: 'singleton' },
  );
  if (error) throw new KeywordsConfigValidationError('save_failed');
  return getKeywordsProviderInfo(serverConfig);
}

type ResolvedProvider = { providerName: 'dataforseo'; config: DataForSeoKeywordsConfig; adapter: DataForSeoKeywordsAdapter };

export interface KeywordsRuntimeOptions {
  dataForSeoAdapterOptions?: DataForSeoKeywordsAdapterOptions;
}

async function resolveProvider(serverConfig: ServerConfig, options: KeywordsRuntimeOptions = {}): Promise<ResolvedProvider> {
  const row = await loadRow(serverConfig);
  if (!row || row.provider_name === 'disabled') {
    throw new KeywordsError(row ? 'keywords_provider_disabled' : 'keywords_provider_not_configured');
  }
  if (!isSupportedKeywordsProvider(row.provider_name)) throw new KeywordsError('keywords_provider_not_configured');
  if (!row.is_active) throw new KeywordsError('keywords_provider_disabled');

  const login = readString(row.config, 'login');
  const password = readString(row.config, 'password');
  if (!login || !password) throw new KeywordsError('keywords_provider_not_configured');

  const config: DataForSeoKeywordsConfig = { provider: 'dataforseo', login, password };
  return { providerName: 'dataforseo', config, adapter: createDataForSeoKeywordsAdapter(config, options.dataForSeoAdapterOptions) };
}

function toErrorCode(err: unknown) {
  return err instanceof KeywordsError ? err.code : 'keywords_provider_error';
}

export async function fetchKeywordDataForSeeds(
  serverConfig: ServerConfig,
  keywords: string[],
  options: KeywordsRuntimeOptions = {},
): Promise<{ provider: string; result: KeywordsFetchResult }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.fetchKeywordData({ keywords });
  return { provider: resolved.providerName, result };
}

/** Ranked keywords a domain currently ranks for (DataForSEO Labs) — the real data behind Site Explorer's Organic Keywords report. */
export async function fetchRankedKeywordsForTarget(
  serverConfig: ServerConfig,
  target: string,
  limit: number,
  options: KeywordsRuntimeOptions = {},
): Promise<{ provider: string; result: RankedKeywordsFetchResult }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.fetchRankedKeywords({ target, limit });
  return { provider: resolved.providerName, result };
}

/** Domains competing for the target's own ranked keywords (DataForSEO Labs) — the real data behind Site Explorer's Competing Domains report. */
export async function fetchCompetingDomainsForTarget(
  serverConfig: ServerConfig,
  target: string,
  limit: number,
  options: KeywordsRuntimeOptions = {},
): Promise<{ provider: string; result: CompetingDomainsFetchResult }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.fetchCompetingDomains({ target, limit });
  return { provider: resolved.providerName, result };
}

export async function testKeywordsProvider(serverConfig: ServerConfig, options: KeywordsRuntimeOptions = {}): Promise<KeywordsTestResult> {
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
      error: err instanceof KeywordsError ? err.message : 'Keyword data provider returned an error',
    };
  }
}
