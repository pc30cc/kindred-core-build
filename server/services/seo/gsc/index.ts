/**
 * SEO GSC INSIGHTS SERVICE
 *
 * The single consumption boundary for Google Search Console in the backend.
 * Mirrors server/services/seo/performance/index.ts's shape, adapted for a
 * per-workspace OAuth connection instead of a platform-singleton API key.
 *
 * Storage:
 *   - `seo_gsc_oauth_states`   short-lived CSRF token for the consent flow.
 *   - `seo_gsc_connections`    one Google account link per workspace. The
 *                              refresh token is stored as an AES-256-GCM
 *                              envelope (server/lib/pluginCrypto.ts) — the
 *                              plaintext value is decrypted only in-process,
 *                              on demand, and NEVER returned to the browser
 *                              or logged.
 *   - `seo_gsc_properties`     Search Console site(s) linked under a
 *                              connection.
 *   - `seo_gsc_query_cache`    short-TTL cache of Search Analytics results.
 *
 * Access tokens are never persisted — only the refresh token is stored.
 * Each data call mints/reuses a short-lived in-memory access token (best
 * effort, per server process; a restart just costs one extra refresh call).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { randomToken, sha256Hex } from '../../invitations/tokens.js';
import { encryptPluginSecret, decryptPluginSecret, isPluginCryptoConfigured, type SecretEnvelope } from '../../../lib/pluginCrypto.js';
import { resolveGscLimits } from '../gscLimits.js';
import { getGoogleOAuthConfig } from './oauthConfig.js';
import { buildGoogleAuthUrl, createGoogleAdapter, type GoogleAdapter, type GoogleSiteEntry } from './providers/google.js';
import {
  GscError,
  type GscConnectionInfo,
  type GscPropertyInfo,
  type GscSearchAnalyticsQuery,
  type GscSearchAnalyticsResult,
} from './types.js';

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function isGscPlatformConfigured(): boolean {
  return getGoogleOAuthConfig() !== null;
}

function adapter(options?: Parameters<typeof createGoogleAdapter>[1]): GoogleAdapter {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) throw new GscError('gsc_not_configured');
  return createGoogleAdapter(cfg, options);
}

// ─── OAuth consent flow ─────────────────────────────────────────────────

export interface StartOAuthResult {
  url: string;
}

export async function startGscOAuth(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<StartOAuthResult> {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) throw new GscError('gsc_not_configured');
  if (!isPluginCryptoConfigured(config.pluginSecretsMasterKey)) throw new GscError('gsc_not_configured');

  const token = randomToken(32);
  const sb = getServiceClient(config);
  const { error } = await sb.from('seo_gsc_oauth_states').insert({
    token,
    workspace_id: workspaceId,
    initiated_by: userId,
    expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  });
  if (error) throw new GscError('gsc_provider_error');

  return { url: buildGoogleAuthUrl(cfg, token) };
}

export interface OAuthCallbackResult {
  workspaceId: string;
}

/** Handles Google's redirect back. Fails closed on any state mismatch/expiry/reuse. */
export async function handleGscOAuthCallback(
  config: ServerConfig,
  code: string,
  state: string,
): Promise<OAuthCallbackResult> {
  const sb = getServiceClient(config);
  const { data: stateRow, error: stateError } = await sb
    .from('seo_gsc_oauth_states')
    .select('token, workspace_id, initiated_by, consumed_at, expires_at')
    .eq('token', state)
    .maybeSingle();
  if (stateError || !stateRow) throw new GscError('gsc_invalid_state');
  if (stateRow.consumed_at) throw new GscError('gsc_invalid_state');
  if (new Date(stateRow.expires_at as string).getTime() < Date.now()) throw new GscError('gsc_invalid_state');

  // Consume atomically-enough: mark used before doing anything else, so a
  // retried/duplicated callback can never replay the same code twice.
  const { error: consumeError, count } = await sb
    .from('seo_gsc_oauth_states')
    .update({ consumed_at: new Date().toISOString() }, { count: 'exact' })
    .eq('token', state)
    .is('consumed_at', null);
  if (consumeError || !count) throw new GscError('gsc_invalid_state');

  const workspaceId = stateRow.workspace_id as string;
  const initiatedBy = stateRow.initiated_by as string;

  const ga = adapter();
  const tokens = await ga.exchangeCodeForTokens(code);
  if (!tokens.refreshToken) {
    // Google only omits this when the account already granted this exact
    // scope without `prompt=consent` taking effect — practically shouldn't
    // happen given buildGoogleAuthUrl always forces consent, but fail
    // closed rather than storing a connection that can never be refreshed.
    throw new GscError('gsc_auth_failed');
  }
  const email = await ga.fetchAccountEmail(tokens.accessToken);

  const envelope = encryptPluginSecret(tokens.refreshToken, config.pluginSecretsMasterKey);
  const { error: upsertError } = await sb.from('seo_gsc_connections').upsert(
    {
      workspace_id: workspaceId,
      google_account_email: email,
      scope: tokens.scope || 'https://www.googleapis.com/auth/webmasters.readonly',
      refresh_token_envelope: envelope,
      status: 'active',
      last_error: null,
      connected_by: initiatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id' },
  );
  if (upsertError) throw new GscError('gsc_provider_error');

  accessTokenCache.delete(workspaceId);
  return { workspaceId };
}

// ─── Connection status / disconnect ────────────────────────────────────

interface StoredConnectionRow {
  id: string;
  google_account_email: string | null;
  refresh_token_envelope: SecretEnvelope;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  created_at: string;
}

async function loadConnectionRow(config: ServerConfig, workspaceId: string): Promise<StoredConnectionRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_gsc_connections')
    .select('id, google_account_email, refresh_token_envelope, status, last_error, created_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new GscError('gsc_provider_error');
  return (data as StoredConnectionRow | null) ?? null;
}

export async function getConnectionInfo(config: ServerConfig, workspaceId: string): Promise<GscConnectionInfo> {
  const row = await loadConnectionRow(config, workspaceId);
  if (!row) return { connected: false, googleAccountEmail: null, status: null, lastError: null, connectedAt: null };
  return {
    connected: row.status === 'active',
    googleAccountEmail: row.google_account_email,
    status: row.status,
    lastError: row.last_error,
    connectedAt: row.created_at,
  };
}

export async function disconnectGsc(config: ServerConfig, workspaceId: string): Promise<void> {
  const row = await loadConnectionRow(config, workspaceId);
  if (!row) return;
  try {
    const refreshToken = decryptPluginSecret(row.refresh_token_envelope, config.pluginSecretsMasterKey);
    await adapter().revokeToken(refreshToken);
  } catch {
    // Best-effort revoke; the local row is removed regardless below.
  }
  const sb = getServiceClient(config);
  await sb.from('seo_gsc_connections').delete().eq('workspace_id', workspaceId);
  accessTokenCache.delete(workspaceId);
}

// ─── Access-token cache (best-effort, in-process only) ─────────────────

const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getAccessToken(config: ServerConfig, workspaceId: string, row: StoredConnectionRow): Promise<string> {
  const cached = accessTokenCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  const refreshToken = decryptPluginSecret(row.refresh_token_envelope, config.pluginSecretsMasterKey);
  const ga = adapter();
  try {
    const tokens = await ga.refreshAccessToken(refreshToken);
    accessTokenCache.set(workspaceId, {
      accessToken: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
    });
    return tokens.accessToken;
  } catch (err) {
    const sb = getServiceClient(config);
    const revoked = err instanceof GscError && err.code === 'gsc_token_revoked';
    await sb
      .from('seo_gsc_connections')
      .update({
        status: revoked ? 'revoked' : 'error',
        last_error: err instanceof GscError ? err.code : 'unknown_error',
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId);
    throw err instanceof GscError ? err : new GscError('gsc_auth_failed');
  }
}

async function resolveActiveConnection(config: ServerConfig, workspaceId: string): Promise<{ row: StoredConnectionRow; accessToken: string }> {
  const row = await loadConnectionRow(config, workspaceId);
  if (!row) throw new GscError('gsc_not_connected');
  if (row.status === 'revoked') throw new GscError('gsc_token_revoked');
  if (row.status === 'error') throw new GscError('gsc_auth_failed');
  const accessToken = await getAccessToken(config, workspaceId, row);
  return { row, accessToken };
}

// ─── Properties ─────────────────────────────────────────────────────────

function toPropertyInfo(row: Record<string, unknown>): GscPropertyInfo {
  return {
    id: row.id as string,
    siteUrl: row.site_url as string,
    permissionLevel: (row.permission_level as string | null) ?? null,
    isPrimary: row.is_primary === true,
    websiteId: (row.website_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function listProperties(config: ServerConfig, workspaceId: string): Promise<GscPropertyInfo[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_gsc_properties')
    .select('id, site_url, permission_level, is_primary, website_id, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new GscError('gsc_provider_error');
  return (data || []).map(toPropertyInfo);
}

/** Google Search Console sites available to the connected account, for the "pick a property" step. */
export async function discoverAvailableSites(config: ServerConfig, workspaceId: string): Promise<GoogleSiteEntry[]> {
  const { accessToken } = await resolveActiveConnection(config, workspaceId);
  return adapter().listSites(accessToken);
}

export class GscLimitError extends GscError {
  constructor() { super('gsc_limit_reached'); }
}

export async function linkProperty(
  config: ServerConfig,
  workspaceId: string,
  siteUrl: string,
  websiteId: string | null,
): Promise<GscPropertyInfo> {
  const { row } = await resolveActiveConnection(config, workspaceId);

  const { limits } = await resolveGscLimits(config, workspaceId);
  const existing = await listProperties(config, workspaceId);
  if (existing.length >= limits.seo_gsc_max_properties) throw new GscLimitError();

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_gsc_properties')
    .insert({
      workspace_id: workspaceId,
      connection_id: row.id,
      site_url: siteUrl,
      website_id: websiteId,
      is_primary: existing.length === 0,
    })
    .select('id, site_url, permission_level, is_primary, website_id, created_at')
    .single();
  if (error || !data) throw new GscError('gsc_provider_error');
  return toPropertyInfo(data);
}

export async function unlinkProperty(config: ServerConfig, workspaceId: string, propertyId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.from('seo_gsc_properties').delete().eq('workspace_id', workspaceId).eq('id', propertyId);
  if (error) throw new GscError('gsc_provider_error');
}

export async function setPrimaryProperty(config: ServerConfig, workspaceId: string, propertyId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { data: prop, error: findError } = await sb
    .from('seo_gsc_properties')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', propertyId)
    .maybeSingle();
  if (findError) throw new GscError('gsc_provider_error');
  if (!prop) throw new GscError('gsc_property_not_found');

  const { error: clearError } = await sb.from('seo_gsc_properties').update({ is_primary: false }).eq('workspace_id', workspaceId);
  if (clearError) throw new GscError('gsc_provider_error');
  const { error: setError } = await sb.from('seo_gsc_properties').update({ is_primary: true }).eq('workspace_id', workspaceId).eq('id', propertyId);
  if (setError) throw new GscError('gsc_provider_error');
}

async function loadProperty(config: ServerConfig, workspaceId: string, propertyId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_gsc_properties')
    .select('id, site_url')
    .eq('workspace_id', workspaceId)
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw new GscError('gsc_provider_error');
  if (!data) throw new GscError('gsc_property_not_found');
  return data as { id: string; site_url: string };
}

// ─── Search Analytics (cached) ──────────────────────────────────────────

function normalizedQueryHash(query: GscSearchAnalyticsQuery): string {
  const canonical = JSON.stringify({
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: [...query.dimensions].sort(),
    rowLimit: query.rowLimit ?? 500,
    startRow: query.startRow ?? 0,
  });
  return sha256Hex(canonical);
}

export async function querySearchAnalytics(
  config: ServerConfig,
  workspaceId: string,
  propertyId: string,
  query: GscSearchAnalyticsQuery,
  opts: { forceRefresh?: boolean } = {},
): Promise<GscSearchAnalyticsResult> {
  const property = await loadProperty(config, workspaceId, propertyId);
  const queryHash = normalizedQueryHash(query);
  const sb = getServiceClient(config);

  if (!opts.forceRefresh) {
    const { limits } = await resolveGscLimits(config, workspaceId);
    const ttlMs = Math.max(1, limits.seo_gsc_sync_frequency_hours) * 60 * 60 * 1000;
    const { data: cachedRow } = await sb
      .from('seo_gsc_query_cache')
      .select('rows, response_aggregation_type, fetched_at')
      .eq('property_id', propertyId)
      .eq('query_hash', queryHash)
      .maybeSingle();
    if (cachedRow && Date.now() - new Date(cachedRow.fetched_at as string).getTime() < ttlMs) {
      return {
        rows: (cachedRow.rows as GscSearchAnalyticsResult['rows']) || [],
        responseAggregationType: (cachedRow.response_aggregation_type as string | null) ?? null,
        cached: true,
        fetchedAt: cachedRow.fetched_at as string,
      };
    }
  }

  const { accessToken } = await resolveActiveConnection(config, workspaceId);
  const result = await adapter().querySearchAnalytics(accessToken, property.site_url, {
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    rowLimit: Math.min(Math.max(query.rowLimit ?? 500, 1), 5000),
    startRow: query.startRow ?? 0,
  });

  const fetchedAt = new Date().toISOString();
  await sb.from('seo_gsc_query_cache').upsert(
    {
      property_id: propertyId,
      query_hash: queryHash,
      query_params: query as unknown as Record<string, unknown>,
      rows: result.rows,
      response_aggregation_type: result.responseAggregationType,
      fetched_at: fetchedAt,
    },
    { onConflict: 'property_id,query_hash' },
  );

  return { rows: result.rows, responseAggregationType: result.responseAggregationType, cached: false, fetchedAt };
}
