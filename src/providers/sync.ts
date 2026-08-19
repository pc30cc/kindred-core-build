// ============================================
// DB → REGISTRY SYNC
// Loads provider_configs and app_runtime_config from the database
// and applies them to the ProviderRegistry at runtime.
// ============================================

import { supabase } from '@/lib/supabase';
import { providerRegistry, type ProviderTypeKey, PROVIDER_TYPE_KEYS } from './registry';

// Track fallback usage for observability
const fallbackLog: Array<{
  type: ProviderTypeKey;
  failedProvider: string;
  fallbackProvider: string;
  timestamp: number;
  error?: string;
}> = [];

export function getFallbackLog() {
  return [...fallbackLog];
}

export function logFallback(
  type: ProviderTypeKey,
  failedProvider: string,
  fallbackProvider: string,
  error?: string
) {
  fallbackLog.push({
    type,
    failedProvider,
    fallbackProvider,
    timestamp: Date.now(),
    error,
  });
  // Keep only last 100 entries
  if (fallbackLog.length > 100) fallbackLog.shift();
  console.warn(
    `[ProviderFallback] ${type}: ${failedProvider} failed → ${fallbackProvider}`,
    error ?? ''
  );
}

/**
 * Load global default provider settings from app_runtime_config
 * and workspace overrides from provider_configs, then apply to registry.
 */
export async function syncProvidersFromDB(workspaceId?: string): Promise<void> {
  try {
    // 1. Load global defaults from app_runtime_config
    const { data: globalConfigs } = await supabase
      .from('app_runtime_config')
      .select('key, value')
      .like('key', 'default_%_provider');

    if (globalConfigs) {
      for (const row of globalConfigs) {
        const match = row.key.match(/^default_(\w+)_provider$/);
        if (!match) continue;
        const type = match[1] as ProviderTypeKey;
        if (!PROVIDER_TYPE_KEYS.includes(type)) continue;
        // Auth is never DB-switchable. First-party gs_session auth
        // (server/routes/auth.ts) is the sole identity system; a
        // `default_auth_provider` row must never be able to flip the
        // active provider here, however it came to exist.
        if (type === 'auth') continue;

        const value = row.value as { provider_name?: string } | null;
        if (value?.provider_name) {
          const registered = providerRegistry.getProviders(type);
          const exists = registered.some(p => p.name === value.provider_name);
          if (exists) {
            providerRegistry.setActive(type, value.provider_name);
          }
        }
      }
    }

    // 2. Load workspace-level overrides
    if (workspaceId) {
      const { data: wsConfigs } = await supabase
        .from('provider_configs')
        .select('provider_type, provider_name, is_active')
        .eq('workspace_id', workspaceId)
        .eq('is_active', true);

      if (wsConfigs) {
        for (const row of wsConfigs) {
          const type = row.provider_type as ProviderTypeKey;
          if (!PROVIDER_TYPE_KEYS.includes(type)) continue;
          providerRegistry.setWorkspaceOverride(workspaceId, type, row.provider_name);
        }
      }
    }

    console.info('[ProviderSync] DB sync complete', {
      globalDefaults: globalConfigs?.length ?? 0,
      workspaceOverrides: workspaceId ? 'loaded' : 'skipped',
    });
  } catch (err) {
    console.error('[ProviderSync] Failed to sync from DB:', err);
  }
}

/**
 * Save a global default provider to app_runtime_config.
 * Also syncs the change to the live registry immediately.
 */
export async function setGlobalDefaultProvider(
  type: ProviderTypeKey,
  providerName: string,
  config?: Record<string, unknown>
): Promise<{ error: Error | null }> {
  // Auth is never DB-switchable — see the matching guard in
  // syncProvidersFromDB above.
  if (type === 'auth') {
    return { error: new Error('The auth provider cannot be changed at runtime.') };
  }
  const key = `default_${type}_provider`;
  const value = { provider_name: providerName, config: config || {} };

  const { error } = await supabase
    .from('app_runtime_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (!error) {
    providerRegistry.setActive(type, providerName);
  }

  return { error: error ? new Error(error.message) : null };
}

/**
 * Remove global default provider — reverts to registry fallback.
 */
export async function removeGlobalDefaultProvider(
  type: ProviderTypeKey
): Promise<{ error: Error | null }> {
  const key = `default_${type}_provider`;
  const { error } = await supabase
    .from('app_runtime_config')
    .delete()
    .eq('key', key);

  if (!error) {
    // Clear active, registry will fall back to priority-based resolution
    providerRegistry.clearActive(type);
  }

  return { error: error ? new Error(error.message) : null };
}

/**
 * Get the current global default for a provider type.
 */
export async function getGlobalDefaultProvider(
  type: ProviderTypeKey
): Promise<{ provider_name: string; config: Record<string, unknown> } | null> {
  const key = `default_${type}_provider`;
  const { data } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  return data?.value as { provider_name: string; config: Record<string, unknown> } | null;
}

/**
 * Get all global default providers at once.
 */
export async function getAllGlobalDefaults(): Promise<
  Record<string, { provider_name: string; config: Record<string, unknown> }>
> {
  const { data } = await supabase
    .from('app_runtime_config')
    .select('key, value')
    .like('key', 'default_%_provider');

  const result: Record<string, { provider_name: string; config: Record<string, unknown> }> = {};
  if (data) {
    for (const row of data) {
      const match = row.key.match(/^default_(\w+)_provider$/);
      if (match) {
        const type = match[1];
        result[type] = row.value as { provider_name: string; config: Record<string, unknown> };
      }
    }
  }
  return result;
}

/**
 * Test a provider connection by running its health check.
 * Returns detailed status including error info.
 */
export async function testProviderConnection(
  type: ProviderTypeKey,
  providerName: string
): Promise<{
  status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'not_configured' | 'auth_failed' | 'network_error';
  message: string;
  checkedAt: number;
}> {
  const health = await providerRegistry.checkHealth(type, providerName);
  const checkedAt = Date.now();

  const messages: Record<string, string> = {
    healthy: 'Connection successful — provider is responding normally.',
    degraded: 'Provider is responding but with degraded performance.',
    down: 'Connection failed — provider is not responding.',
    unknown: 'No health check available for this provider.',
  };

  return {
    status: health,
    message: messages[health] ?? 'Status unknown.',
    checkedAt,
  };
}
