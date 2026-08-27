// ============================================
// DB → REGISTRY SYNC
// Loads provider_configs and app_runtime_config from the database
// and applies them to the ProviderRegistry at runtime.
// ============================================

import { API_BASE } from '@/lib/apiBase';
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
 * All provider metadata now comes from first-party Express endpoints:
 *  - GET  /api/account/provider-defaults          (authenticated read)
 *  - GET  /api/workspaces/:id/provider-selection  (workspace member read)
 *  - PUT/DELETE /api/admin/management/runtime-config/:key (platform admin)
 * The browser never reads `app_runtime_config`/`provider_configs` directly,
 * and provider credentials never leave the backend.
 */
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error || `Request failed: ${res.status}`);
  return body as T;
}

/**
 * Load global default provider settings
 * and workspace overrides from provider_configs, then apply to registry.
 */
export async function syncProvidersFromDB(workspaceId?: string): Promise<void> {
  try {
    // 1. Load global defaults (non-secret provider names only)
    const { defaults } = await apiFetch<{ defaults: Record<string, string> }>(
      '/api/account/provider-defaults',
    );

    for (const [rawType, providerName] of Object.entries(defaults ?? {})) {
      const type = rawType as ProviderTypeKey;
      if (!PROVIDER_TYPE_KEYS.includes(type)) continue;
      // Auth is never DB-switchable. First-party gs_session auth
      // (server/routes/auth.ts) is the sole identity system.
      if (type === 'auth') continue;
      const registered = providerRegistry.getProviders(type);
      if (registered.some(p => p.name === providerName)) {
        providerRegistry.setActive(type, providerName);
      }
    }

    // 2. Load workspace-level overrides
    if (workspaceId) {
      const { overrides } = await apiFetch<{
        overrides: Array<{ provider_type: string; provider_name: string; is_active: boolean }>;
      }>(`/api/workspaces/${workspaceId}/provider-selection`);

      for (const row of overrides ?? []) {
        const type = row.provider_type as ProviderTypeKey;
        if (!PROVIDER_TYPE_KEYS.includes(type)) continue;
        providerRegistry.setWorkspaceOverride(workspaceId, type, row.provider_name);
      }
    }

    console.info('[ProviderSync] DB sync complete', {
      globalDefaults: Object.keys(defaults ?? {}).length,
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

  try {
    await apiFetch(`/api/admin/management/runtime-config/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  } catch (err) {
    return { error: err instanceof Error ? err : new Error('Failed to save provider default') };
  }

  providerRegistry.setActive(type, providerName);
  return { error: null };
}

/**
 * Remove global default provider — reverts to registry fallback.
 */
export async function removeGlobalDefaultProvider(
  type: ProviderTypeKey
): Promise<{ error: Error | null }> {
  const key = `default_${type}_provider`;
  try {
    await apiFetch(`/api/admin/management/runtime-config/${key}`, { method: 'DELETE' });
  } catch (err) {
    return { error: err instanceof Error ? err : new Error('Failed to remove provider default') };
  }

  // Clear active, registry will fall back to priority-based resolution
  providerRegistry.clearActive(type);
  return { error: null };
}

/**
 * Get the current global default for a provider type.
 */
export async function getGlobalDefaultProvider(
  type: ProviderTypeKey
): Promise<{ provider_name: string; config: Record<string, unknown> } | null> {
  const key = `default_${type}_provider`;
  try {
    const { value } = await apiFetch<{ value: unknown }>(
      `/api/admin/management/runtime-config/${key}`,
    );
    return (value as { provider_name: string; config: Record<string, unknown> } | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Get all global default providers at once.
 */
export async function getAllGlobalDefaults(): Promise<
  Record<string, { provider_name: string; config: Record<string, unknown> }>
> {
  const result: Record<string, { provider_name: string; config: Record<string, unknown> }> = {};
  try {
    const { defaults } = await apiFetch<{ defaults: Record<string, string> }>(
      '/api/account/provider-defaults',
    );
    for (const [type, provider_name] of Object.entries(defaults ?? {})) {
      result[type] = { provider_name, config: {} };
    }
  } catch {
    /* registry falls back to priority-based resolution */
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
