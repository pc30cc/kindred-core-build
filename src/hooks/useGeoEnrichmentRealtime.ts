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
            const payload = raw as any;
            if (!payload || payload.kind !== 'visitor.upsert') return;
            if (payload.workspace_id && payload.workspace_id !== workspaceId) return;
            if (!payload.patch?.geo_enriched) return;
            qc.invalidateQueries({ queryKey: ['visitor-network', workspaceId] });
            qc.invalidateQueries({ queryKey: ['visitor-network', 'batch', workspaceId] });
            // Inbox embeds the batched profiles inside its conversations
            // query, so that cache has to be refreshed too.
            qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
          },
        });
        if (cancelled) { subscription.unsubscribe(); return; }
        sub = subscription;
      } catch (err) {
        rtWarn('geo', 'subscribe failed, polling continues', { error: (err as any)?.message });
      }
    })();

    return () => {
      cancelled = true;
      if (sub) { try { sub.unsubscribe(); } catch { /* noop */ } sub = null; }
    };
  }, [workspaceId, qc]);
}
