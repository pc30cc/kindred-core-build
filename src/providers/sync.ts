// ============================================
// DB → REGISTRY SYNC
// Loads provider_configs and app_runtime_config from the database
// and applies them to the ProviderRegistry at runtime.
// This is the missing bridge layer.
// ============================================

import { supabase } from '@/lib/supabase';
import { providerRegistry, type ProviderTypeKey, PROVIDER_TYPE_KEYS } from './registry';

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
        // key format: default_email_provider → type = email
        const match = row.key.match(/^default_(\w+)_provider$/);
        if (!match) continue;
        const type = match[1] as ProviderTypeKey;
        if (!PROVIDER_TYPE_KEYS.includes(type)) continue;

        const value = row.value as { provider_name?: string } | null;
        if (value?.provider_name) {
          // If this provider is already registered, set it as active
          const registered = providerRegistry.getProviders(type);
          const exists = registered.some(p => p.name === value.provider_name);
          if (exists) {
            providerRegistry.setActive(type, value.provider_name);
          }
          // Store the config reference for edge function resolution
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
 */
export async function setGlobalDefaultProvider(
  type: ProviderTypeKey,
  providerName: string,
  config?: Record<string, unknown>
): Promise<{ error: Error | null }> {
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
