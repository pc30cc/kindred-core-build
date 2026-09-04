/**
 * Realtime resolver — single global resolution path.
 *  - Loads the admin-configured global realtime provider from `app_runtime_config`.
 *  - Returns: effective vendor, capabilities, public config (no secrets), fallback policy.
 *
 * GLOBAL ONLY. No workspace-level overrides in this phase.
 */

import type { ServerConfig } from '../../config.js';
import { CentrifugoDriver } from './centrifugo.js';
import { loadRealtimeConfig } from './store.js';
import {
  CENTRIFUGO_CAPABILITIES,
  DISABLED_CAPABILITIES,
  POLLING_CAPABILITIES,
  type ResolvedRealtimeProvider,
  type RealtimeProviderConfig,
} from './types.js';

export * from './types.js';
export { CentrifugoDriver } from './centrifugo.js';
export { loadRealtimeConfig, saveRealtimeConfig, invalidateRealtimeCache, maskedConfig } from './store.js';
export {
  getNodeHealth,
  getClusterHealth,
  peekNodeHealth,
  invalidateNodeHealth,
  effectiveNodeStatus,
  type NodeHealthSnapshot,
} from './nodeHealth.js';
export { selectNode, eligibleNodes, type NodeSelectionResult } from './nodeRouter.js';
export {
  listNodes,
  addNode,
  updateNode,
  removeNode,
  setNodeDraining,
  getDeploymentMode,
  type NodeInput,
} from './nodeRegistry.js';
export { assignRealtimeEndpoint, type RealtimeAssignment } from './assignment.js';

/**
 * Resolve the effective realtime provider.
 * Order:
 *   1) global default (if enabled and config valid) — source = 'global_default'
 *   2) fallback to polling if policy = lenient and primary failed/missing — source = 'fallback'
 *   3) strict mode + primary unavailable → source = 'failed_closed', vendor = 'disabled'
 */
export async function resolveRealtimeProvider(
  config: ServerConfig,
  options: { skipHealth?: boolean } = {}
): Promise<ResolvedRealtimeProvider> {
  const cfg = await loadRealtimeConfig(config);

  if (!cfg.enabled || cfg.vendor === 'disabled') {
    return {
      effective_vendor: 'disabled',
      source: 'disabled',
      capabilities: DISABLED_CAPABILITIES,
      public_config: {},
      fallback_policy: cfg.fallback_policy,
      health: { status: 'unknown', message: 'Realtime disabled by admin' },
    };
  }

  if (cfg.vendor === 'centrifugo') {
    const c = cfg.centrifugo;
    const isConfigured = !!(c?.ws_url && c?.api_url && c?.api_key && c?.token_hmac_secret);

    if (!isConfigured) {
      return fallbackOrFail(cfg, 'Centrifugo not fully configured');
    }

    let healthStatus: 'healthy' | 'degraded' | 'down' | 'unknown' = 'unknown';
    let healthMessage: string | undefined;
    if (!options.skipHealth) {
      const driver = new CentrifugoDriver(c as Required<typeof c>);
      const h = await driver.health();
      healthStatus = h.status;
      healthMessage = h.message;
      if (h.status === 'down') {
        return fallbackOrFail(cfg, `Centrifugo unreachable: ${h.message}`);
      }
    }

    return {
      effective_vendor: 'centrifugo',
      source: 'global_default',
      capabilities: CENTRIFUGO_CAPABILITIES,
      public_config: {
        ws_url: c!.ws_url,
        allowed_origins: c!.allowed_origins,
        connect_timeout_ms: c!.connect_timeout_ms ?? 8000,
        subscribe_timeout_ms: c!.subscribe_timeout_ms ?? 5000,
        presence_enabled: c!.presence_enabled ?? false,
        typing_enabled: c!.typing_enabled ?? true,
      },
      fallback_policy: cfg.fallback_policy,
      health: { status: healthStatus, checked_at: Date.now(), message: healthMessage },
    };
  }

  if (cfg.vendor === 'supabase') {
    // Supabase Realtime: client connects directly via supabase-js using
    // the project's anon key (already shipped to the browser). No server
    // token issuance is needed. Capabilities mirror Centrifugo's broadcast
    // surface — no presence/typing guarantees from this path today.
    return {
      effective_vendor: 'supabase',
      source: 'global_default',
      capabilities: {
        supportsRealtime: true,
        supportsTyping: false,
        supportsPresence: false,
        supportsHistoryLoad: true,
        supportsReconnectSignals: true,
      },
      public_config: {},
      fallback_policy: cfg.fallback_policy,
      health: { status: 'healthy', checked_at: Date.now(), message: 'Supabase Realtime' },
    };
  }

  // polling_builtin
  return {
    effective_vendor: 'polling_builtin',
    source: 'global_default',
    capabilities: POLLING_CAPABILITIES,
    public_config: {},
    fallback_policy: cfg.fallback_policy,
    health: { status: 'healthy', checked_at: Date.now(), message: 'Built-in polling' },
  };
}

function fallbackOrFail(
  cfg: RealtimeProviderConfig,
  reason: string
): ResolvedRealtimeProvider {
  if (cfg.fallback_policy === 'strict') {
    return {
      effective_vendor: 'disabled',
      source: 'failed_closed',
      capabilities: DISABLED_CAPABILITIES,
      public_config: {},
      fallback_policy: 'strict',
      health: { status: 'down', checked_at: Date.now(), message: reason },
    };
  }
  return {
    effective_vendor: 'polling_builtin',
    source: 'fallback',
    capabilities: POLLING_CAPABILITIES,
    public_config: {},
    fallback_policy: cfg.fallback_policy,
    health: { status: 'degraded', checked_at: Date.now(), message: reason },
  };
}

/** Build and return a Centrifugo driver from current config — null if not configured. */
export async function getCentrifugoDriver(config: ServerConfig): Promise<CentrifugoDriver | null> {
  const cfg = await loadRealtimeConfig(config);
  if (cfg.vendor !== 'centrifugo' || !cfg.enabled || !cfg.centrifugo) return null;
  const c = cfg.centrifugo;
  if (!c.ws_url || !c.api_url || !c.api_key || !c.token_hmac_secret) return null;
  return new CentrifugoDriver(c as Required<typeof c>);
}
