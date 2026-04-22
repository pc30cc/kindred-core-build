/**
 * Phase 8A — Call provider resolver.
 *
 * Decision order:
 *   1. Per-workspace `provider_override` (if set and ready)
 *   2. Global `primary_provider` (if ready)
 *   3. Global `secondary_provider` (if ready and fallback_policy='lenient')
 *   4. throw — never silently degrade to a non-call transport.
 */
import type { ServerConfig } from '../../config.js';
import {
  loadCallControlPlane,
  loadWorkspaceCallOverrides,
  type CallProviderId,
} from './controlPlane.js';
import { livekitProvider } from './providers/livekitProvider.js';
import { jitsiProvider } from './providers/jitsiProvider.js';
import { janusProvider } from './providers/janusProvider.js';
import { agoraProvider } from './providers/agoraProvider.js';
import {
  CallProviderNotReadyError,
  CALL_PROVIDER_CLASSIFICATION,
  type CallProvider,
} from './providers/types.js';

const REGISTRY: Record<Exclude<CallProviderId, 'disabled'>, CallProvider> = {
  livekit: livekitProvider,
  jitsi: jitsiProvider,
  janus: janusProvider,
  // External / cloud-backed adapter — opt-in only. NEVER auto-included
  // in the default order; admin must explicitly select agora_cloud.
  agora_cloud: agoraProvider,
};

export function getCallProvider(id: CallProviderId): CallProvider | null {
  if (id === 'disabled') return null;
  return REGISTRY[id] ?? null;
}

/** Returns the ordered list of provider candidates (no readiness check). */
export async function resolveCallProviderOrder(
  config: ServerConfig,
  workspaceId: string,
): Promise<CallProviderId[]> {
  const cp = await loadCallControlPlane(config);
  const ws = await loadWorkspaceCallOverrides(config, workspaceId);
  const order: CallProviderId[] = [];
  if (ws.provider_override) order.push(ws.provider_override);
  if (!order.includes(cp.primary_provider)) order.push(cp.primary_provider);
  if (cp.fallback_policy === 'lenient' && !order.includes(cp.secondary_provider)) {
    order.push(cp.secondary_provider);
  }
  // STRICT: external providers (e.g. Agora) MUST NOT appear in the order
  // unless the admin has explicitly chosen them as workspace_override,
  // primary_provider, or secondary_provider above. We also never silently
  // auto-promote them via fallback expansion. The filter below preserves
  // explicit choices and only drops 'disabled'.
  return order.filter((p) => p !== 'disabled');
}

/** Returns the first ready provider, or throws. */
export async function resolveEffectiveCallProvider(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ id: CallProviderId; provider: CallProvider }> {
  const cp = await loadCallControlPlane(config);
  if (!cp.enabled) {
    throw new CallProviderNotReadyError(
      'disabled',
      'Voice/Video calls are disabled in the control plane.',
    );
  }

  const order = await resolveCallProviderOrder(config, workspaceId);
  for (const id of order) {
    const provider = getCallProvider(id);
    if (!provider) continue;
    try {
      if (await provider.isReady(config)) return { id, provider };
    } catch {
      // try next
    }
  }

  throw new CallProviderNotReadyError(
    'disabled',
    `No call provider is ready (tried: ${order.join(', ') || 'none'}).`,
  );
}

export function resolveCallProvider(id: CallProviderId): CallProvider {
  const p = getCallProvider(id);
  if (!p) {
    throw new CallProviderNotReadyError(id, `Unknown call provider id: ${id}`);
  }
  return p;
}