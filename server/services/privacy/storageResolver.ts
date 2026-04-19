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
 * Object key convention (enforced here, never trusted from caller):
 *   privacy-exports/<workspace_id|"_self">/<job_id>.zip
 *
 * Privacy export artifacts MUST never be exposed via a public URL — the
 * download route always streams through backend authorization with a
 * single-use token. Provider-level public URLs are intentionally not used.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { StorageConfig } from '../storage/index.js';

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

function mapDBConfigToStorage(provider: string, c: any): StorageConfig {
  return {
    provider,
    apiKey: c.api_key,
    storageZone: c.storage_zone,
    region: c.region,
    cdnUrl: c.cdn_url || c.cdn_endpoint || c.public_url,
    accessKeyId: c.access_key_id || c.access_key,
    secretAccessKey: c.secret_access_key || c.secret_key,
    bucket: c.bucket || c.container,
    s3Region: c.region,
    endpoint: c.endpoint,
    localPath: c.local_path || c.path,
    publicUrl: c.public_url,
    maxFileSizeMB: c.max_file_size ? parseInt(c.max_file_size) : undefined,
  };
}

/**
 * Build the canonical, provider-agnostic object key for an export artifact.
 * Always namespaced under privacy-exports/ to keep PII isolated from normal
 * customer-facing assets, even if both share a bucket.
 */
export function buildPrivacyArtifactKey(
  workspaceId: string | null,
  jobId: string,
): string {
  const ws = workspaceId || '_self';
  return `privacy-exports/${ws}/${jobId}.zip`;
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
      return {
        provider: wsConfig.provider_name,
        config: mapDBConfigToStorage(wsConfig.provider_name, wsConfig.config as any),
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

  const platform = (globalRow?.value as any) || null;
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
        config: mapDBConfigToStorage(attConfig.provider_name, attConfig.config as any),
        source: 'attachment_fallback',
        allowAttachmentFallback: true,
      };
    }
  }

  throw new PrivacyStorageNotConfigured(
    'No privacy-export storage provider is configured. Configure a platform default or a workspace override under Admin → Providers → Privacy Export Storage.',
  );
}
