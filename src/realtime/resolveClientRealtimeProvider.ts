/**
 * Resolve the active client-side realtime provider for a given workspace.
 *
 * Resolution order (matches the agreed plan):
 *   1. Workspace realtime override (provider_configs row, type='realtime',
 *      is_active=true). The override is honored only if the named vendor
 *      has a working client adapter on day one (centrifugo / supabase).
 *   2. Global active provider — discovered by negotiating with the
 *      backend via POST /api/realtime/operator-connect. The server is
 *      already the single source of truth for vendor selection
 *      (`server/services/realtime/index.ts → resolveRealtimeProvider`).
 *   3. Polling fallback — always returned on failure or when realtime is
 *      disabled. Never throws.
 *
 * The resolver returns an instance, never null. Callers can subscribe
 * unconditionally and trust the polling adapter as a safe no-op.
 *
 * Per-workspace memoization keeps a single provider instance alive for
 * the whole tab session, so repeated mounts of the Inbox don't
 * re-negotiate or re-open sockets.
 */

import { supabase } from '@/lib/supabase';
import type {
  ClientRealtimeProvider,
  RealtimeNegotiation,
  RealtimeVendor,
} from './types';
import { CentrifugoClientProvider } from './providers/centrifugo';
import { SupabaseRealtimeClientProvider } from './providers/supabase';
import { PollingClientProvider } from './providers/polling';
import { rtDebug, rtWarn } from './debug';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';

const SUPPORTED_VENDORS: RealtimeVendor[] = ['centrifugo', 'supabase'];

const cache = new Map<string, Promise<ClientRealtimeProvider>>();

/**
 * Drop the cached provider for a workspace so the next resolve call
 * re-negotiates (fresh ws_url + connection token). Used by adapters
 * when the underlying socket dies and a new negotiation is needed.
 */
export function invalidateClientRealtimeCache(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

async function fetchWorkspaceOverride(workspaceId: string): Promise<RealtimeVendor | null> {
  try {
    const { data } = await supabase
      .from('provider_configs')
      .select('provider_name, is_active')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'realtime')
      .eq('is_active', true)
      .maybeSingle();
    const name = (data as any)?.provider_name as string | undefined;
    if (!name) return null;
    return SUPPORTED_VENDORS.includes(name as RealtimeVendor) ? (name as RealtimeVendor) : null;
  } catch {
    return null;
  }
}

async function negotiate(workspaceId: string): Promise<RealtimeNegotiation | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-connect`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RealtimeNegotiation;
  } catch {
    return null;
  }
}

function buildAdapter(
  vendor: RealtimeVendor,
  negotiation: RealtimeNegotiation | null,
): ClientRealtimeProvider {
  try {
    if (vendor === 'centrifugo' && negotiation?.ws_url && negotiation.token) {
      return new CentrifugoClientProvider(negotiation);
    }
    if (vendor === 'supabase') {
      return new SupabaseRealtimeClientProvider();
    }
  } catch {
    /* fall through to polling */
  }
  return new PollingClientProvider();
}

export function resolveClientRealtimeProvider(workspaceId: string): Promise<ClientRealtimeProvider> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;

  const promise = (async (): Promise<ClientRealtimeProvider> => {
    rtDebug('resolve', 'start', { workspaceId });

    // 1. Workspace override (only if the vendor has a day-one adapter).
    const override = await fetchWorkspaceOverride(workspaceId);
    if (override) rtDebug('resolve', 'workspace override found', { override });

    if (override === 'supabase') {
      rtDebug('resolve', 'final vendor', { vendor: 'supabase', source: 'workspace_override' });
      return new SupabaseRealtimeClientProvider();
    }
    // For centrifugo override we still need the negotiation to get ws_url + token.
    const negotiation = await negotiate(workspaceId);
    if (negotiation) {
      rtDebug('resolve', 'global negotiation', {
        vendor: negotiation.vendor,
        hasWsUrl: !!negotiation.ws_url,
        hasToken: !!negotiation.token,
      });
    } else {
      rtWarn('resolve', 'global negotiation failed');
    }

    if (override === 'centrifugo' && negotiation?.ws_url && negotiation.token) {
      rtDebug('resolve', 'final vendor', { vendor: 'centrifugo', source: 'workspace_override' });
      return new CentrifugoClientProvider(negotiation);
    }

    // 2. Global active vendor as reported by the server.
    if (negotiation && SUPPORTED_VENDORS.includes(negotiation.vendor)) {
      rtDebug('resolve', 'final vendor', { vendor: negotiation.vendor, source: 'global_default' });
      return buildAdapter(negotiation.vendor, negotiation);
    }

    // 3. Fallback.
    rtDebug('resolve', 'final vendor', { vendor: 'polling', source: 'fallback' });
    return new PollingClientProvider();
  })();

  cache.set(workspaceId, promise);
  // If the negotiation fails permanently we still cache the polling result,
  // which is the desired behavior (no retry storms).
  return promise;
}

/** Test/debug only — clears the per-workspace memo. Not used in app code. */
export function __resetClientRealtimeCache(): void {
  cache.clear();
}
