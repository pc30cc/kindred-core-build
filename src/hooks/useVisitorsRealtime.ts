/**
 * Visitor Intelligence realtime subscription.
 *
 * Subscribes to the operator-only channel `ws:<workspace_id>:visitors`
 * and patches the cached live-list / map-marker queries when
 * `visitor.upsert` / `visitor.remove` events arrive.
 *
 * Polling fallback: when the resolved provider is `polling`/`disabled`,
 * subscribe is a safe no-op and the existing 10–15 s React Query refetch
 * keeps the UI fresh — same behavior as before this hook existed.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime/types';
import { rtDebug, rtWarn } from '@/realtime/debug';
import type { VisitorIntelItem, MapMarker } from '@/lib/visitors-api';

interface VisitorEventPayload {
  kind: 'visitor.upsert' | 'visitor.remove';
  workspace_id: string;
  session_id: string;
  patch?: {
    status?: VisitorIntelItem['status'];
    current_page?: string | null;
    last_activity_at?: string;
    visitor_id?: string;
  };
  occurred_at: string;
}

export function useVisitorsRealtime(workspaceId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let sub: RealtimeSubscription | null = null;
    const channel = `ws:${workspaceId}:visitors`;

    (async () => {
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (cancelled) return;
        rtDebug('visitors', 'subscribing', { vendor: provider.vendor, channel });

        const subscription = await provider.subscribe(channel, {
          onEvent: (raw) => {
            if (!raw || typeof raw !== 'object') return;
            const payload = raw as unknown as VisitorEventPayload;
            if (payload.workspace_id && payload.workspace_id !== workspaceId) return;
            if (payload.kind !== 'visitor.upsert' && payload.kind !== 'visitor.remove') return;

            if (payload.kind === 'visitor.remove') {
              applyRemove(qc, workspaceId, payload.session_id);
              return;
            }

            // visitor.upsert: try to patch in-place; if session is unknown,
            // invalidate so the next refetch pulls the full normalized row.
            const matched = applyUpsertPatch(qc, workspaceId, payload);
            if (!matched) {
              qc.invalidateQueries({ queryKey: ['visitor-intel-live', workspaceId] });
              qc.invalidateQueries({ queryKey: ['visitor-intel-map', workspaceId] });
            }

            // Always refresh the per-visitor detail cache if the drawer is open.
            qc.invalidateQueries({
              queryKey: ['visitor-intel-detail', workspaceId, payload.session_id],
            });
          },
          onStatus: (status, info) => {
            if (status === 'error') rtWarn('visitors', 'status=error', { reason: info?.reason });
          },
        });
        if (cancelled) { subscription.unsubscribe(); return; }
        sub = subscription;
      } catch (err) {
        rtWarn('visitors', 'subscribe failed, polling continues', {
          error: (err as any)?.message,
        });
      }
    })();

    return () => {
      cancelled = true;
      if (sub) { try { sub.unsubscribe(); } catch { /* noop */ } sub = null; }
    };
  }, [workspaceId, qc]);
}

// ─────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────

function applyRemove(qc: ReturnType<typeof useQueryClient>, wsId: string, sessionId: string) {
  const liveQueries = qc.getQueriesData<{ items: VisitorIntelItem[] }>({
    queryKey: ['visitor-intel-live', wsId],
  });
  for (const [key, data] of liveQueries) {
    if (!data?.items) continue;
    const next = data.items.filter((i) => i.id !== sessionId);
    if (next.length !== data.items.length) qc.setQueryData(key, { ...data, items: next });
  }

  const mapQueries = qc.getQueriesData<{ markers: MapMarker[]; total: number }>({
    queryKey: ['visitor-intel-map', wsId],
  });
  for (const [key, data] of mapQueries) {
    if (!data?.markers) continue;
    const next = data.markers.filter((m) => m.id !== sessionId);
    if (next.length !== data.markers.length) {
      qc.setQueryData(key, { ...data, markers: next, total: Math.max(0, (data.total ?? 0) - 1) });
    }
  }
}

function applyUpsertPatch(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string,
  payload: VisitorEventPayload,
): boolean {
  let matchedAny = false;

  const liveQueries = qc.getQueriesData<{ items: VisitorIntelItem[] }>({
    queryKey: ['visitor-intel-live', wsId],
  });
  for (const [key, data] of liveQueries) {
    if (!data?.items) continue;
    const idx = data.items.findIndex((i) => i.id === payload.session_id);
    if (idx < 0) continue;
    matchedAny = true;
    const next = data.items.slice();
    const prev = next[idx];
    next[idx] = {
      ...prev,
      status: payload.patch?.status ?? prev.status,
      current_page: payload.patch?.current_page ?? prev.current_page,
      last_activity_at: payload.patch?.last_activity_at ?? prev.last_activity_at,
    };
    // Re-sort by last_activity_at desc so newly active visitors bubble up.
    next.sort(
      (a, b) =>
        new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime(),
    );
    qc.setQueryData(key, { ...data, items: next });
  }

  const mapQueries = qc.getQueriesData<{ markers: MapMarker[]; total: number }>({
    queryKey: ['visitor-intel-map', wsId],
  });
  for (const [key, data] of mapQueries) {
    if (!data?.markers) continue;
    const idx = data.markers.findIndex((m) => m.id === payload.session_id);
    if (idx < 0) continue;
    matchedAny = true;
    const next = data.markers.slice();
    next[idx] = {
      ...next[idx],
      status: payload.patch?.status ?? next[idx].status,
      current_page: payload.patch?.current_page ?? next[idx].current_page,
    };
    qc.setQueryData(key, { ...data, markers: next });
  }

  return matchedAny;
}
