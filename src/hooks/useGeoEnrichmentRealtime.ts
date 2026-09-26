/**
 * useGeoEnrichmentRealtime — refresh canonical network profiles when the
 * server finishes geo enrichment.
 *
 * Geo resolution runs asynchronously AFTER ingestion, so a conversation or
 * call can be rendered before its country/city exists. Rather than adding a
 * second realtime system, this reuses the existing operator-only visitors
 * channel (`ws:<id>:visitors`) and the existing `visitor.upsert` envelope:
 * the enrichment step now sets `patch.geo_enriched`, and any surface that
 * shows network data invalidates its cached profiles when that arrives.
 *
 * Polling fallback is unchanged — when realtime is disabled, subscribe is a
 * no-op and the 60s React Query staleTime still refreshes profiles.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime/types';
import { rtWarn } from '@/realtime/debug';
import { invalidateThrottled } from '@/realtime/invalidationThrottle';

/**
 * One geo_enriched event arrives per new visitor session — most of whom never
 * start a conversation — and each used to refetch the network profiles AND
 * the whole conversation list on every open Inbox and Call Center page. Geo
 * is decorative and already arrives asynchronously, so these refreshes are
 * batched generously.
 */
const PROFILE_REFRESH_WINDOW_MS = 5_000;
const CONVERSATIONS_REFRESH_WINDOW_MS = 10_000;

interface GeoVisitorEvent {
  kind?: string;
  workspace_id?: string;
  patch?: { geo_enriched?: boolean };
}

export function useGeoEnrichmentRealtime(workspaceId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let sub: RealtimeSubscription | null = null;

    (async () => {
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (cancelled) return;
        const subscription = await provider.subscribe(`ws:${workspaceId}:visitors`, {
          onEvent: (raw) => {
            const payload = raw as GeoVisitorEvent | null;
            if (!payload || payload.kind !== 'visitor.upsert') return;
            if (payload.workspace_id && payload.workspace_id !== workspaceId) return;
            if (!payload.patch?.geo_enriched) return;
            invalidateThrottled(qc, ['visitor-network', workspaceId], PROFILE_REFRESH_WINDOW_MS);
            invalidateThrottled(qc, ['visitor-network', 'batch', workspaceId], PROFILE_REFRESH_WINDOW_MS);
            // Inbox embeds the batched profiles inside its conversations
            // query, so that cache has to be refreshed too.
            invalidateThrottled(qc, ['conversations', workspaceId], CONVERSATIONS_REFRESH_WINDOW_MS);
          },
        });
        if (cancelled) { subscription.unsubscribe(); return; }
        sub = subscription;
      } catch (err) {
        rtWarn('geo', 'subscribe failed, polling continues', { error: (err as Error | undefined)?.message });
      }
    })();

    return () => {
      cancelled = true;
      if (sub) { try { sub.unsubscribe(); } catch { /* noop */ } sub = null; }
    };
  }, [workspaceId, qc]);
}
