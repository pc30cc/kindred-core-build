/**
 * SEO BACKLINKS SERVICE
 *
 * The single consumption boundary for backlink-data vendor calls in the
 * backend. Mirrors server/services/sms/index.ts's shape exactly.
 *
 * Storage: `public.platform_backlinks_provider_config` — a service-role-only
 * table. The credential lives there and is read ONLY by this module through
 * the service client. It is never returned to the browser and never logged.
 *
 * Resolution (this phase): the single active platform-level config.
 * Workspace overrides are intentionally NOT consulted: which vendor answers
 * "who links to this site" is a platform operations decision, not a
 * per-workspace setting — usage is instead bounded per workspace by
 * server/services/seo/backlinksLimits.ts. The adapter registry below is the
 * extension point for future vendors (Moz, Ahrefs API, ...).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  BacklinksError,
  BACKLINKS_PROVIDER_NAMES,
  SUPPORTED_BACKLINKS_PROVIDERS,
  type BacklinksFetchResult,
  type BacklinksProviderInfo,
  type BacklinksProviderName,
  type BacklinksTestResult,
  type DataForSeoBacklinksConfig,
} from './types.js';
import { createDataForSeoAdapter, type DataForSeoAdapter, type DataForSeoAdapterOptions } from './providers/dataforseo.js';

const TABLE = 'platform_backlinks_provider_config';

export function isSupportedBacklinksProvider(value: unknown): value is 'dataforseo' {
  return typeof value === 'string' && (SUPPORTED_BACKLINKS_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownBacklinksProviderName(value: unknown): value is BacklinksProviderName {
  return typeof value === 'string' && (BACKLINKS_PROVIDER_NAMES as readonly string[]).includes(value);
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
  if (error) throw new BacklinksError('backlinks_provider_not_configured');
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
export async function getBacklinksProviderInfo(serverConfig: ServerConfig): Promise<BacklinksProviderInfo> {
  const row = await loadRow(serverConfig);
  if (!row) {
    return { providerName: 'disabled', configured: false, enabled: false, hasCredentials: false, login: null, updatedAt: null };
  }
  const providerName: BacklinksProviderName = isKnownBacklinksProviderName(row.provider_name) ? row.provider_name : 'disabled';
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

export interface SaveBacklinksProviderInput {
  providerName: string;
  enabled: boolean;
  login?: string;
  /** Omitted / blank on update = keep the stored credential. */
  password?: string;
}

export type SaveBacklinksProviderError = 'unsupported_provider' | 'login_required' | 'password_required' | 'save_failed';

export class BacklinksConfigValidationError extends Error {
  readonly reason: SaveBacklinksProviderError;
  constructor(reason: SaveBacklinksProviderError) {
    super(reason);
    this.name = 'BacklinksConfigValidationError';
    this.reason = reason;
  }
}

/** Persist the platform backlinks-provider config. Only whitelisted keys are stored. */
export async function saveBacklinksProviderConfig(
  serverConfig: ServerConfig,
  input: SaveBacklinksProviderInput,
  adminUserId: string,
): Promise<BacklinksProviderInfo> {
  if (!isSupportedBacklinksProvider(input.providerName)) {
    throw new BacklinksConfigValidationError('unsupported_provider');
  }

  const existing = await loadRow(serverConfig);
  const sameProvider = existing?.provider_name === input.providerName;

  const incomingLogin = typeof input.login === 'string' ? input.login.trim() : '';
  const existingLogin = sameProvider ? readString(existing?.config ?? null, 'login') : null;
  const login = incomingLogin !== '' ? incomingLogin : existingLogin;
  if (!login) throw new BacklinksConfigValidationError('login_required');

  const incomingPassword = typeof input.password === 'string' ? input.password.trim() : '';
  const existingPassword = sameProvider ? readString(existing?.config ?? null, 'password') : null;
  const password = incomingPassword !== '' ? incomingPassword : existingPassword;
  if (!password) throw new BacklinksConfigValidationError('password_required');

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
  if (error) throw new BacklinksConfigValidationError('save_failed');

  return getBacklinksProviderInfo(serverConfig);
}

/** Disable and wipe the stored credential. */
export async function deleteBacklinksProviderConfig(serverConfig: ServerConfig, adminUserId: string): Promise<BacklinksProviderInfo> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    { singleton: true, provider_name: 'disabled', config: {}, is_active: false, updated_by: adminUserId, updated_at: new Date().toISOString() },
    { onConflict: 'singleton' },
  );
  if (error) throw new BacklinksConfigValidationError('save_failed');
  return getBacklinksProviderInfo(serverConfig);
}

type ResolvedProvider = { providerName: 'dataforseo'; config: DataForSeoBacklinksConfig; adapter: DataForSeoAdapter };

export interface BacklinksRuntimeOptions {
  /** Test seam forwarded to the DataForSEO adapter. */
  dataForSeoAdapterOptions?: DataForSeoAdapterOptions;
}

/** Resolve the active provider. Fail-closed at every gap: missing row, disabled flag, unsupported vendor, or incomplete credential. */
async function resolveProvider(serverConfig: ServerConfig, options: BacklinksRuntimeOptions = {}): Promise<ResolvedProvider> {
  const row = await loadRow(serverConfig);
  if (!row || row.provider_name === 'disabled') {
    throw new BacklinksError(row ? 'backlinks_provider_disabled' : 'backlinks_provider_not_configured');
  }
  if (!isSupportedBacklinksProvider(row.provider_name)) throw new BacklinksError('backlinks_provider_not_configured');
  if (!row.is_active) throw new BacklinksError('backlinks_provider_disabled');

  const login = readString(row.config, 'login');
  const password = readString(row.config, 'password');
  if (!login || !password) throw new BacklinksError('backlinks_provider_not_configured');

  const config: DataForSeoBacklinksConfig = { provider: 'dataforseo', login, password };
  return { providerName: 'dataforseo', config, adapter: createDataForSeoAdapter(config, options.dataForSeoAdapterOptions) };
}

function toErrorCode(err: unknown) {
  return err instanceof BacklinksError ? err.code : 'backlinks_provider_error';
}

/** Fetch backlinks for a target URL. Internal service API — no public route calls the vendor directly. */
export async function fetchBacklinksForTarget(
  serverConfig: ServerConfig,
  target: string,
  limit: number,
  options: BacklinksRuntimeOptions = {},
): Promise<{ provider: string; result: BacklinksFetchResult }> {
  const resolved = await resolveProvider(serverConfig, options);
  const result = await resolved.adapter.fetchBacklinks({ target, limit });
  return { provider: resolved.providerName, result };
}

/** Admin connection test. Reads account info only — never fetches backlink data. */
export async function testBacklinksProvider(serverConfig: ServerConfig, options: BacklinksRuntimeOptions = {}): Promise<BacklinksTestResult> {
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
      error: err instanceof BacklinksError ? err.message : 'Backlinks data provider returned an error',
    };
  }
}
