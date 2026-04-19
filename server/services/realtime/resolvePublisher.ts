/**
 * Resolve the active server-side realtime publisher for a given workspace.
 *
 * Resolution order (mirrors the client-side resolver):
 *   1. Workspace realtime override — `provider_configs` row with
 *      `provider_type = 'realtime'`, `is_active = true`, `provider_name`
 *      in { 'centrifugo', 'supabase' }. Honored only if the named vendor
 *      has a server-side publisher implementation.
 *   2. Global active vendor — read from `app_runtime_config` via
 *      `loadRealtimeConfig()`. Today this can be 'centrifugo',
 *      'polling_builtin', or 'disabled'. We also accept 'supabase' if a
 *      future migration extends the enum, so this resolver is forward-
 *      compatible.
 *   3. NoopPublisher fallback — never throws. Polling drives the UI.
 *
 * In-process memoization: a single publisher instance per workspace is
 * cached for 30 seconds, matching the realtime config cache TTL. This
 * avoids re-reading provider_configs on every message send.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getCentrifugoDriver, loadRealtimeConfig } from './index.js';
import { CentrifugoPublisher } from './publishers/centrifugo.js';
import { SupabaseRealtimePublisher } from './publishers/supabase.js';
import { NoopPublisher } from './publishers/noop.js';
import type { ServerRealtimePublisher } from './publishers/types.js';
import { rtDebug, rtWarn } from './debug.js';

const SUPPORTED_OVERRIDE_VENDORS = new Set(['centrifugo', 'supabase']);
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  publisher: ServerRealtimePublisher;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function invalidatePublisherCache(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

async function fetchWorkspaceOverride(
  config: ServerConfig,
  workspaceId: string,
): Promise<'centrifugo' | 'supabase' | null> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('provider_configs')
      .select('provider_name, is_active')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'realtime')
      .eq('is_active', true)
      .maybeSingle();
    if (error) return null;
    const name = (data as any)?.provider_name as string | undefined;
    if (!name || !SUPPORTED_OVERRIDE_VENDORS.has(name)) return null;
    return name as 'centrifugo' | 'supabase';
  } catch {
    return null;
  }
}

async function buildPublisher(
  config: ServerConfig,
  vendor: 'centrifugo' | 'supabase' | string,
): Promise<ServerRealtimePublisher> {
  if (vendor === 'centrifugo') {
    const driver = await getCentrifugoDriver(config);
    if (!driver) return new NoopPublisher();
    return new CentrifugoPublisher(driver);
  }
  if (vendor === 'supabase') {
    return new SupabaseRealtimePublisher(getServiceClient(config));
  }
  return new NoopPublisher();
}

export async function resolvePublisher(
  config: ServerConfig,
  workspaceId: string,
): Promise<ServerRealtimePublisher> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.publisher;
  }

  let publisher: ServerRealtimePublisher;
  let source: 'workspace_override' | 'global_default' | 'fallback';

  // 1. Workspace override.
  const override = await fetchWorkspaceOverride(config, workspaceId);
  if (override) {
    rtDebug('resolve', 'workspace override found', { workspaceId, override });
    publisher = await buildPublisher(config, override);
    source = 'workspace_override';
  } else {
    // 2. Global active vendor.
    const cfg = await loadRealtimeConfig(config);
    rtDebug('resolve', 'global config', {
      workspaceId,
      vendor: cfg.vendor,
      enabled: cfg.enabled,
    });
    if (!cfg.enabled) {
      publisher = new NoopPublisher();
      source = 'fallback';
    } else {
      publisher = await buildPublisher(config, cfg.vendor);
      source = publisher.vendor === 'noop' ? 'fallback' : 'global_default';
    }
  }

  if (publisher.vendor === 'noop' && source !== 'fallback') {
    rtWarn('resolve', 'falling back to noop', { workspaceId });
  }
  rtDebug('resolve', 'final publisher', { workspaceId, vendor: publisher.vendor, source });

  cache.set(workspaceId, { publisher, loadedAt: Date.now() });
  return publisher;
}
