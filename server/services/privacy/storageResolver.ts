/**
 * Privacy export → storage provider resolver.
 *
 * Privacy exports use the SAME storage provider system as the rest of the
 * app (BunnyCDN, S3-compatible, local persistent disk, etc.) but resolve
 * via a DEDICATED policy so they can:
 *   - point to a different provider than normal attachments
 *   - be force-isolated to a specific provider per workspace
 *   - explicitly opt in/out of falling back to the general attachment
 *     storage provider when no privacy-export-specific provider is set
 *
 * Resolution order (first match wins):
 *   1. Workspace privacy-export override         provider_configs(provider_type='privacy_export_storage', workspace_id=..., is_active=true)
 *   2. Platform privacy-export default           app_runtime_config(key='privacy_export_storage')  → { provider, config, allow_attachment_fallback }
 *   3. (only if allow_attachment_fallback)       active attachment storage provider for the workspace
 *   4. fail with a clear configuration error     — never silently write to /tmp
 *
 * The resolved descriptor is provider-agnostic: { provider, config, source }
 * Callers use server/services/storage upload/download/delete handlers
 * directly with the returned StorageConfig, so we reuse every existing
 * provider implementation (no one-off code path).
 *
 * Object key convention: workspace/<workspaceId>/exports/privacy/<jobId>.zip
 * for workspace-scoped jobs (contact/visitor), or
 * users/<userId>/exports/privacy/<jobId>.zip for user-subject jobs (which
 * never have a workspace_id — see server/services/privacy/types.ts). Built
 * exclusively by server/services/storage/keys.ts's privacyExportKey() — the
 * key is never trusted from a caller.
 *
 * Privacy export artifacts MUST never be exposed via a public URL — the
 * download route always streams through backend authorization with a
 * single-use token. Provider-level public URLs are intentionally not used.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { StorageConfig } from '../storage/index.js';
import { checkOutboundUrl } from '../../../shared/net/hostGuard.js';

/**
 * The providers a workspace may name for its OWN privacy-export storage
 * (PUT /api/workspace-integrations/:id/privacy-storage). `local` is not one
 * of them: it would let a workspace pick a directory on the server's disk.
 */
export const WORKSPACE_PRIVACY_STORAGE_PROVIDERS = ['s3', 'cloudflare_r2', 'minio', 'do_spaces', 'bunny_storage'] as const;

const S3_FAMILY = new Set<string>(['s3', 'cloudflare_r2', 'minio', 'do_spaces']);
/** A bucket name as S3 and its look-alikes allow it: no `/`, `?`, `#`, `@`, `:` or `%`. */
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** An S3 region goes into the default host name (`s3.<region>.amazonaws.com`). */
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/i;
/** Bunny's region and zone go into its host name and path. */
const BUNNY_REGION_RE = /^[a-z0-9]{1,10}$/i;
const BUNNY_ZONE_RE = /^[a-z0-9_-]{1,64}$/i;

/**
 * Why a workspace's own privacy-export storage may not be used, or null.
 *
 * The server itself talks to that storage — it uploads the export, and on
 * download reads it back and hands the body to the caller — so the address is
 * the workspace's to choose only within what cannot reach inside our own
 * network: a public https host (checkOutboundUrl, DNS included), a plain
 * bucket and region that cannot rewrite the URL, Bunny's fixed host. Checked
 * when the override is saved AND every time it is resolved, so a row saved
 * before this check (or a DNS record changed since) is refused too.
 */
export async function workspacePrivacyStorageRefusal(provider: string, config: StorageConfig): Promise<string | null> {
  if (!(WORKSPACE_PRIVACY_STORAGE_PROVIDERS as readonly string[]).includes(provider)) return 'unsupported_provider';
  if (provider === 'bunny_storage') {
    if (config.region && !BUNNY_REGION_RE.test(config.region)) return 'invalid_region';
    if (config.storageZone && !BUNNY_ZONE_RE.test(config.storageZone)) return 'invalid_storage_zone';
    return null;
  }
  if (!S3_FAMILY.has(provider)) return 'unsupported_provider';
  if (config.bucket && !BUCKET_RE.test(config.bucket)) return 'invalid_bucket';
  if (config.s3Region && !S3_REGION_RE.test(config.s3Region)) return 'invalid_region';
  if (config.endpoint) {
    let url: URL;
    try {
      url = new URL(config.endpoint);
    } catch {
      return 'invalid_endpoint';
    }
    // A query or fragment would swallow the bucket and key the driver
    // appends, turning the endpoint into any URL on that host.
    if (url.search || url.hash || config.endpoint.includes('?') || config.endpoint.includes('#')) return 'invalid_endpoint';
    const check = await checkOutboundUrl(config.endpoint);
    if (!check.ok) return 'endpoint_not_public';
  }
  return null;
}

/** The same check, for the raw `config` object a workspace sends. */
export async function workspacePrivacyStorageRefusalForRaw(provider: string, raw: Record<string, unknown>): Promise<string | null> {
  return workspacePrivacyStorageRefusal(provider, mapDBConfigToStorage(provider, raw));
}

export interface PrivacyStoragePolicy {
  /** Provider name (e.g. "local", "s3", "bunny_storage"). */
  provider: string;
  /** Concrete provider config used by storage handlers. */
  config: StorageConfig;
  /** Where the policy came from — used for logging/audit only. */
  source: 'workspace_override' | 'platform_default' | 'attachment_fallback';
  /**
   * If true, calling code may fall back to the generic attachment storage
   * provider when this policy is missing. The resolver itself already honors
   * this; exposed for diagnostics.
   */
  allowAttachmentFallback: boolean;
}

export class PrivacyStorageNotConfigured extends Error {
  code = 'PRIVACY_STORAGE_NOT_CONFIGURED' as const;
  constructor(message: string) {
    super(message);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function mapDBConfigToStorage(provider: string, c: Record<string, unknown>): StorageConfig {
  const maxFileSize = c.max_file_size;
  return {
    provider,
    apiKey: asString(c.api_key),
    storageZone: asString(c.storage_zone),
    region: asString(c.region),
    cdnUrl: asString(c.cdn_url) ?? asString(c.cdn_endpoint) ?? asString(c.public_url),
    accessKeyId: asString(c.access_key_id) ?? asString(c.access_key),
    secretAccessKey: asString(c.secret_access_key) ?? asString(c.secret_key),
    bucket: asString(c.bucket) ?? asString(c.container),
    s3Region: asString(c.region),
    endpoint: asString(c.endpoint),
    localPath: asString(c.local_path) ?? asString(c.path),
    publicUrl: asString(c.public_url),
    maxFileSizeMB:
      typeof maxFileSize === 'number' || typeof maxFileSize === 'string'
        ? parseInt(String(maxFileSize), 10)
        : undefined,
  };
}

/**
 * Resolve the privacy-export storage policy for a given workspace.
 * Throws PrivacyStorageNotConfigured if no policy can be determined and
 * fallback is not allowed.
 */
export async function resolvePrivacyStoragePolicy(
  serverConfig: ServerConfig,
  workspaceId: string | null,
): Promise<PrivacyStoragePolicy> {
  const sb = getServiceClient(serverConfig);

  // 1. Workspace-level privacy-export override
  if (workspaceId) {
    const { data: wsConfig } = await sb
      .from('provider_configs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'privacy_export_storage')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (wsConfig?.config) {
      const overrideConfig = mapDBConfigToStorage(wsConfig.provider_name, wsConfig.config as Record<string, unknown>);
      // Fail closed: an override the workspace may not use is never quietly
      // swapped for the platform's storage (its exports would land somewhere
      // it did not choose); the job or download fails with this error.
      const refusal = await workspacePrivacyStorageRefusal(wsConfig.provider_name, overrideConfig);
      if (refusal) {
        console.warn('[privacy-storage] workspace override refused', { workspaceId, provider: wsConfig.provider_name, refusal });
        throw new PrivacyStorageNotConfigured(`Workspace privacy-export storage override refused (${refusal})`);
      }
      return {
        provider: wsConfig.provider_name,
        // The endpoint is the workspace's: its requests never follow a redirect.
        config: { ...overrideConfig, untrustedEndpoint: true },
        source: 'workspace_override',
        allowAttachmentFallback: false,
      };
    }
  }

  // 2. Platform-level privacy-export default
  const { data: globalRow } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'privacy_export_storage')
    .maybeSingle();

  const platform = (globalRow?.value ?? null) as { provider?: string; config?: Record<string, unknown>; allow_attachment_fallback?: boolean } | null;
  const allowAttachmentFallback = Boolean(platform?.allow_attachment_fallback);

  if (platform?.provider && platform?.config) {
    return {
      provider: platform.provider,
      config: mapDBConfigToStorage(platform.provider, platform.config),
      source: 'platform_default',
      allowAttachmentFallback,
    };
  }

  // 3. Attachment storage fallback (only if explicitly allowed)
  if (allowAttachmentFallback && workspaceId) {
    const { data: attConfig } = await sb
      .from('provider_configs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'storage')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (attConfig?.config) {
      return {
        provider: attConfig.provider_name,
        config: mapDBConfigToStorage(attConfig.provider_name, attConfig.config as Record<string, unknown>),
        source: 'attachment_fallback',
        allowAttachmentFallback: true,
      };
    }
  }

  throw new PrivacyStorageNotConfigured(
    'No privacy-export storage provider is configured. Configure a platform default or a workspace override under Admin → Providers → Privacy Export Storage.',
  );
}
